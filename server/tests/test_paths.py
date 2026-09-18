"""路径边界与数据正确性单元测试（优化文档 5.2 / 12.2）。

既可用 pytest 运行（`python -m pytest server/tests/test_paths.py`），
也可独立执行（`server/.venv/Scripts/python.exe server/tests/test_paths.py`）——
独立模式下自动把 server/ 加入 sys.path，并输出逐条 PASS/FAIL 结果。

覆盖点：
- 字符串前缀 vs is_relative_to：兄弟目录（workspace vs workspace-escape）
  不能再骗过边界校验；
- /files/list-dir 与 /optimize/serve-file 的 workspace / 临时目录边界；
- /process/mesh 的 mesh_url 解析边界；
- 工作流原子保存（schemaVersion 落盘、临时文件清理、非法 id 拒绝）；
- 清理缓存的递归 uploads 引用扫描（嵌套 params 不漏扫）；
- 任务注册表：终态记录、TTL 清理。
"""

import os
import sys
import tempfile
import time
from pathlib import Path

# 必须在导入任何 server 模块之前设置数据目录，把可变数据隔离到临时目录。
_TEST_ROOT = Path(tempfile.mkdtemp(prefix='meshforge_paths_test_'))
os.environ['MESHFORGE_DATA_DIR'] = str(_TEST_ROOT)

SERVER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_DIR))

from fastapi import HTTPException  # noqa: E402

from config import DATA_DIR, WORKSPACE_DIR  # noqa: E402
from jobstore import JobStore  # noqa: E402
from jobs import JobRegistry, JobState, jobs as _jobs_singleton  # noqa: E402
from routers import settings as settings_router  # noqa: E402
from routers import workflows as workflows_router  # noqa: E402
from routers.extensions import MAX_FOLDER_FILES, _extract_zip_capped  # noqa: E402
from routers.generate import _within_import_temp, _within_workspace  # noqa: E402
from routers.generate import list_dir, serve_imported_file  # noqa: E402
from routers.model import _safe_dest_path  # noqa: E402
from routers.process import _resolve_local  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, fn) -> None:
    """运行单个用例并记录结果；独立运行模式下最终汇总输出。"""
    try:
        fn()
        RESULTS.append((name, True, ''))
        print(f'PASS {name}')
    except Exception as exc:  # noqa: BLE001
        RESULTS.append((name, False, f'{type(exc).__name__}: {exc}'))
        print(f'FAIL {name}: {type(exc).__name__}: {exc}')


# ─── 测试环境搭建 ─────────────────────────────────────────────────────────────

WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
# 兄弟目录：字符串前缀与 workspace 相同，正是 12.2 的最小复现场景。
ESCAPE_DIR = _TEST_ROOT / 'workspace-escape'
ESCAPE_DIR.mkdir(exist_ok=True)

_escape_glb = ESCAPE_DIR / 'payload.glb'
_escape_glb.write_bytes(b'glTF-fake')
_workspace_glb = WORKSPACE_DIR / 'inside.glb'
_workspace_glb.write_bytes(b'glTF-fake')


def test_sibling_prefix_rejected() -> None:
    """workspace-escape/payload.glb 必须被拒绝（startswith 会误判为 True）。"""
    assert not _within_workspace(_escape_glb.resolve())
    # 旧实现等价于：str(escape).startswith(str(workspace)) → True（漏洞）。
    assert _escape_glb.resolve().is_relative_to(WORKSPACE_DIR.resolve()) is False


def test_workspace_file_accepted() -> None:
    assert _within_workspace(_workspace_glb.resolve())


def test_list_dir_rejects_escape() -> None:
    try:
        list_dir(dir='..')
    except HTTPException as exc:
        assert exc.status_code == 400
        return
    raise AssertionError('list_dir(..) should be rejected')


def test_list_dir_sibling_prefix_rejected() -> None:
    # dir 参数拼出 workspace-escape 时同样必须拒绝。
    try:
        list_dir(dir='../workspace-escape')
    except HTTPException as exc:
        assert exc.status_code == 400
        return
    raise AssertionError('sibling dir should be rejected')


def test_serve_file_rejects_outside() -> None:
    try:
        serve_imported_file(path=str(_escape_glb))
    except HTTPException as exc:
        assert exc.status_code == 403
        return
    raise AssertionError('serve-file outside workspace should be 403')


def test_serve_file_allows_workspace() -> None:
    resp = serve_imported_file(path=str(_workspace_glb))
    assert Path(resp.path).resolve() == _workspace_glb.resolve()


def test_serve_file_rejects_other_tmp() -> None:
    other = Path(tempfile.mkdtemp(prefix='other_tool_')) / 'x.glb'
    other.write_bytes(b'glTF-fake')
    try:
        serve_imported_file(path=str(other))
    except HTTPException as exc:
        assert exc.status_code == 403
        return
    raise AssertionError('unrelated temp dir should be 403')


def test_import_temp_allowed() -> None:
    import tempfile as _tf

    tmp_dir = Path(_tf.mkdtemp(prefix='meshforge_import_'))
    glb = tmp_dir / 'mesh.glb'
    glb.write_bytes(b'glTF-fake')
    assert _within_import_temp(glb.resolve())


def test_process_rejects_bare_outside_path() -> None:
    try:
        _resolve_local(str(_escape_glb))
    except HTTPException as exc:
        assert exc.status_code == 400
        return
    raise AssertionError('bare path outside workspace should be rejected')


def test_workflow_atomic_save_and_schema_version() -> None:
    payload = workflows_router.WorkflowIn(id='demo-wf', name='Demo', nodes=[], edges=[])
    assert workflows_router.save_workflow(payload) == {'ok': True}
    saved = workflows_router.WORKFLOWS_DIR / 'demo-wf.json'
    data = __import__('json').loads(saved.read_text(encoding='utf-8'))
    assert data['schemaVersion'] == workflows_router.SCHEMA_VERSION
    # 原子写入完成后不应残留 .tmp 文件。
    assert not list(workflows_router.WORKFLOWS_DIR.glob('*.tmp'))


def test_workflow_rejects_bad_id() -> None:
    try:
        workflows_router._safe_path('../../etc/passwd')
    except HTTPException as exc:
        assert exc.status_code == 400
        return
    raise AssertionError('bad workflow id should be rejected')


def test_referenced_uploads_recursive() -> None:
    import json as _json

    wf = {
        'nodes': [
            {
                'id': 'n1',
                'data': {
                    # 引用藏在嵌套 params 数组里——旧实现只扫 data.url，会漏掉。
                    'params': {'images': [{'url': '/files/uploads/abc.png'}]},
                },
            }
        ]
    }
    (workflows_router.WORKFLOWS_DIR / 'refs-wf.json').write_text(
        _json.dumps(wf), encoding='utf-8'
    )
    referenced = settings_router._referenced_upload_names()
    assert 'abc.png' in referenced


def test_job_ttl_reap() -> None:
    reg = JobRegistry()
    job = reg.create('hunyuan3d-2-mini')
    reg.mark_finished(job, JobState.SUCCEEDED)
    assert reg.get(job.job_id) is not None
    # 模拟过期：把 finished_at 拨回 TTL 之外。
    job.finished_at = time.time() - 7 * 3600
    assert reg.reap_expired() == 1
    assert reg.get(job.job_id) is None


def test_job_cancel_flag_isolated() -> None:
    reg = JobRegistry()
    a = reg.create('hunyuan3d-2-mini')
    b = reg.create('hunyuan3d-2-mini')
    assert reg.request_cancel(a.job_id) is True
    assert reg._cancel_flag(a.job_id).is_set()
    assert not reg._cancel_flag(b.job_id).is_set()


def test_model_dest_path_rejects_traversal() -> None:
    """远端清单里的文件名不得逃出模型目录（优化文档 12.6）。"""
    import tempfile as _tf

    base = Path(_tf.mkdtemp(prefix='mf_dest_'))
    ok = _safe_dest_path(base, 'sub/model.bin')
    assert ok.is_relative_to(base.resolve())
    for bad in ('../evil.bin', '..\\evil.bin', 'C:/abs/x', '/abs/x'):
        try:
            _safe_dest_path(base, bad)
        except ValueError:
            continue
        raise AssertionError(f'unsafe filename accepted: {bad}')


def test_zip_extract_skips_slip_and_caps_files() -> None:
    """zip-slip 成员被跳过；文件数超限返回 413（优化文档 12.4）。"""
    import tempfile as _tf
    import zipfile

    base = Path(_tf.mkdtemp(prefix='mf_zip_'))
    zpath = base / 'a.zip'
    with zipfile.ZipFile(zpath, 'w') as zf:
        zf.writestr('ok.txt', 'x')
        zf.writestr('../evil.txt', 'x')
        zf.writestr('/abs.txt', 'x')
    out = base / 'out'
    _extract_zip_capped(zpath, out)
    assert (out / 'ok.txt').is_file()
    assert not (base / 'evil.txt').exists()
    assert not (out / 'abs.txt').exists()

    zpath2 = base / 'b.zip'
    with zipfile.ZipFile(zpath2, 'w') as zf:
        for i in range(MAX_FOLDER_FILES + 1):
            zf.writestr(f'f{i}.txt', 'x')
    try:
        _extract_zip_capped(zpath2, base / 'out2')
    except HTTPException as exc:
        assert exc.status_code == 413
    else:
        raise AssertionError('file count cap did not trigger')


def test_jobstore_persists_terminal_state() -> None:
    """终态写入 SQLite 后可按 id 查回（重启后历史可查，文档 4.1）。"""
    import tempfile as _tf

    store = JobStore(Path(_tf.mkdtemp(prefix='mf_db_')) / 'jobs.db')
    store.record_terminal(
        job_id='abc123', generator_id='test-dummy', state='succeeded',
        progress=1.0, message='done', result_url='/files/abc123/m.glb',
        error=None, created_at=1.0, finished_at=2.0,
    )
    row = store.get('abc123')
    assert row is not None and row['state'] == 'succeeded' and row['result_url'] == '/files/abc123/m.glb'
    assert store.get('missing') is None
    assert any(r['job_id'] == 'abc123' for r in store.recent(limit=10))


def test_job_queue_is_cancellable() -> None:
    """同一模型并发槽占满时新任务排队（PENDING + Queued），可取消（文档 4.1）。"""
    import asyncio

    from generators.base import BaseGenerator
    from generators.registry import registry as _gen_registry

    class _Dummy(BaseGenerator):
        id = 'test-dummy'
        display_name = 'Dummy'
        input_type = 'image'
        output_type = 'mesh'
        category = 'mesh'
        params: list = []

        def generate(self, image_path, out_dir, params, progress=None, cancel=None):
            raise NotImplementedError

    if _gen_registry.get('test-dummy') is None:
        _gen_registry.register(_Dummy())

    reg = _jobs_singleton
    slot = reg._gen_slot('test-dummy')
    slot.acquire()  # 占满唯一的并发槽

    job = reg.create('test-dummy')

    async def runner() -> None:
        task = asyncio.ensure_future(
            reg.run(job, Path('unused.png'), WORKSPACE_DIR / '_q_test', {})
        )
        await asyncio.sleep(0.3)
        assert job.state == JobState.PENDING, f'expected queued/pending, got {job.state}'
        assert 'Queued' in job.message
        assert reg.request_cancel(job.job_id) is True
        await asyncio.wait_for(task, timeout=5)
        assert job.state == JobState.CANCELLED

    try:
        asyncio.run(runner())
    finally:
        slot.release()


def test_agent_url_validation() -> None:
    """provider URL 校验：本地 http 放行、远程必须 https、其他协议/元数据拒绝。"""
    from routers.agent import _validate_provider_url

    assert _validate_provider_url('http://localhost:11434/', lan_http_ok=True) == 'http://localhost:11434'
    assert _validate_provider_url('http://127.0.0.1:8766', lan_http_ok=True) == 'http://127.0.0.1:8766'
    assert _validate_provider_url('http://192.168.1.5:11434', lan_http_ok=True) == 'http://192.168.1.5:11434'
    assert _validate_provider_url('https://api.deepseek.com/v1', lan_http_ok=False) == 'https://api.deepseek.com/v1'
    for bad_url, lan in (
        ('file:///etc/passwd', True),
        ('http://169.254.169.254/latest/meta-data', True),
        ('http://api.example.com/v1', False),  # 远程明文 http
        ('http://user:pass@host', True),  # userinfo
        ('', True),  # 空
    ):
        try:
            _validate_provider_url(bad_url, lan_http_ok=lan)
        except RuntimeError:
            continue
        raise AssertionError(f'unsafe provider URL accepted: {bad_url}')


def test_library_pagination_and_cache() -> None:
    """library 分页生效；新增文件使签名缓存失效；uploads 顶层剪枝（文档 6.2）。"""
    from routers import library as library_router

    ws = WORKSPACE_DIR
    (ws / 'exports').mkdir(exist_ok=True)
    (ws / 'exports' / 'lib-a.glb').write_bytes(b'x')
    r1 = library_router.list_library(offset=0, limit=1)
    assert r1['total'] >= 1 and len(r1['entries']) == 1
    # 缓存命中：数据未变时 total 稳定（不重建条目）。
    r2 = library_router.list_library()
    assert r2['total'] == r1['total']
    # 新文件 → mtime 签名变化 → 缓存失效、条目重建。
    (ws / 'exports' / 'lib-b.glb').write_bytes(b'x')
    r3 = library_router.list_library()
    assert r3['total'] == r1['total'] + 1
    # 顶层 uploads 整棵剪枝，不计入资产。
    up = ws / 'uploads'
    up.mkdir(exist_ok=True)
    (up / 'lib-c.glb').write_bytes(b'x')
    r4 = library_router.list_library()
    assert r4['total'] == r3['total']


def test_health_endpoint_tiers() -> None:
    """健康检查分级：live 公开、ready 公开、status 需认证（文档 13.4）。"""
    from fastapi.testclient import TestClient

    from main import app

    client = TestClient(app)
    assert client.get('/health').json()['status'] == 'ok'
    assert client.get('/health/live').json()['status'] == 'ok'
    # 数据目录可写（测试临时目录）→ ready 200。
    assert client.get('/health/ready').status_code == 200
    # status 含本机路径等诊断细节，必须带 token。
    assert client.get('/health/status').status_code == 401


if __name__ == '__main__':
    for _name, _fn in sorted(
        ((k, v) for k, v in list(globals().items()) if k.startswith('test_') and callable(v))
    ):
        check(_name, _fn)
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed, data dir: {DATA_DIR}')
    sys.exit(1 if failed else 0)
