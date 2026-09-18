"""工作流持久化路由的单元测试（优化文档 5.2）。

既可用 pytest 运行（`python -m pytest server/tests/test_workflows.py`），
也可独立执行（`server/.venv/Scripts/python.exe server/tests/test_workflows.py`）。

覆盖点（全部经 FastAPI TestClient 走真实路由栈）：
- 保存 / 读取回环：nodes/edges 原样保留，schemaVersion / updatedAt 补写；
- 列表：摘要不含图体、按 updatedAt 倒序、损坏文件静默跳过；
- 非法 id（路径穿越形态）被 400 拒绝；
- 节点 / 边超限 413；
- 删除幂等。
"""

import os
import sys
import tempfile
from pathlib import Path

# 必须在导入任何 server 模块之前设置数据目录，把 workspace/workflows 隔离到临时目录。
_TEST_ROOT = Path(tempfile.mkdtemp(prefix='meshforge_wf_test_'))
os.environ['MESHFORGE_DATA_DIR'] = str(_TEST_ROOT)

SERVER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_DIR))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from routers import workflows as workflows_router  # noqa: E402

app = FastAPI()
app.include_router(workflows_router.router)
client = TestClient(app)

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


def _payload(wf_id: str, name: str = 'Demo', nodes: list | None = None, edges: list | None = None) -> dict:
    return {
        'id': wf_id,
        'name': name,
        'description': '',
        'nodes': nodes if nodes is not None else [{'id': 'n1', 'type': 'imageNode', 'data': {'label': 'img'}}],
        'edges': edges if edges is not None else [{'id': 'e1', 'source': 'n1', 'target': 'n2'}],
        'createdAt': '2026-09-18T10:00:00',
        'updatedAt': '',
    }


# ─── 用例 ─────────────────────────────────────────────────────────────────────

def test_save_get_roundtrip() -> None:
    """保存后再读取：图体字段原样保留，schemaVersion 由服务端补写。"""
    body = _payload('wf-roundtrip', nodes=[{'id': 'a'}, {'id': 'b'}], edges=[{'id': 'x', 'source': 'a', 'target': 'b'}])
    r = client.post('/workflows', json=body)
    assert r.status_code == 200 and r.json() == {'ok': True}
    g = client.get('/workflows/wf-roundtrip')
    assert g.status_code == 200
    data = g.json()
    assert data['name'] == 'Demo'
    assert data['nodes'] == [{'id': 'a'}, {'id': 'b'}]
    assert data['edges'] == [{'id': 'x', 'source': 'a', 'target': 'b'}]
    assert data['schemaVersion'] >= 1
    assert data['updatedAt']  # 空串被服务端时间戳兜底


def test_get_missing_404() -> None:
    assert client.get('/workflows/wf-not-there').status_code == 404


def test_invalid_id_rejected() -> None:
    """路径穿越 / 非白名单字符的 id 一律 400（白名单式校验）。"""
    for bad in ('../etc/passwd', 'a/b', 'a b', 'a b/c', '.', '..'):
        r = client.post('/workflows', json=_payload(bad))
        assert r.status_code == 400, f'{bad!r} should be rejected'
    assert client.get('/workflows/..%2Fetc').status_code in (400, 404)


def test_list_summary_sorted() -> None:
    """列表返回摘要（无 nodes/edges），按 updatedAt 倒序。"""
    client.post('/workflows', json=_payload('wf-old', name='Old'))
    client.post('/workflows', json=_payload('wf-new', name='New'))
    r = client.get('/workflows')
    assert r.status_code == 200
    items = r.json()
    assert all('nodes' not in it and 'edges' not in it for it in items)
    ids = [it['id'] for it in items]
    assert 'wf-new' in ids and 'wf-old' in ids
    # updatedAt 倒序：new 排在 old 之前。
    assert ids.index('wf-new') < ids.index('wf-old')


def test_corrupted_file_skipped() -> None:
    """损坏的 JSON 文件被列表静默跳过，不拖垮整个端点。"""
    from routers.workflows import WORKFLOWS_DIR

    (WORKFLOWS_DIR / 'wf-broken.json').write_text('{not json', encoding='utf-8')
    r = client.get('/workflows')
    assert r.status_code == 200
    assert 'wf-broken' not in [it['id'] for it in r.json()]


def test_limits_413() -> None:
    """节点 / 边数量超限返回 413，拦截异常巨大的请求体。"""
    many_nodes = [{'id': f'n{i}'} for i in range(501)]
    r = client.post('/workflows', json=_payload('wf-big-nodes', nodes=many_nodes, edges=[]))
    assert r.status_code == 413
    many_edges = [{'id': f'e{i}', 'source': 'a', 'target': 'b'} for i in range(1001)]
    r = client.post('/workflows', json=_payload('wf-big-edges', nodes=[], edges=many_edges))
    assert r.status_code == 413


def test_delete_idempotent() -> None:
    """删除存在的与不存在的 id 都返回 ok（幂等，方便前端删后刷新）。"""
    client.post('/workflows', json=_payload('wf-doomed'))
    assert client.delete('/workflows/wf-doomed').json() == {'ok': True}
    assert client.get('/workflows/wf-doomed').status_code == 404
    assert client.delete('/workflows/wf-doomed').json() == {'ok': True}


def test_atomic_save_no_tmp_left() -> None:
    """原子保存：成功路径不残留 .json.tmp 临时文件。"""
    client.post('/workflows', json=_payload('wf-atomic'))
    tmps = list(workflows_router.WORKFLOWS_DIR.glob('*.tmp'))
    assert tmps == []


if __name__ == '__main__':
    for _name, _fn in sorted((n, f) for n, f in globals().items() if n.startswith('test_') and callable(f)):
        check(_name, _fn)
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed, data dir: {_TEST_ROOT}')
    import shutil

    shutil.rmtree(_TEST_ROOT, ignore_errors=True)
    sys.exit(1 if failed else 0)
