"""任务注册表与持久化单元测试（优化文档 5.2）。

既可用 pytest 运行（`python -m pytest server/tests/test_jobs.py`），
也可独立执行（`server/.venv/Scripts/python.exe server/tests/test_jobs.py`）——
独立模式下自动把 server/ 加入 sys.path，并输出逐条 PASS/FAIL 结果。

覆盖点：
- 任务创建 / 查询 / 取消标志的生命周期；
- 未知生成器 → FAILED 且错误信息落库（jobs.db 可查）；
- mark_finished 终态持久化 + JobStore 独立实例的读写回环；
- TTL 清理：过期终态被回收，运行中 / 未到期任务保留。
"""

import os
import sys
import tempfile
import time
from pathlib import Path

# 必须在导入任何 server 模块之前设置数据目录，把 jobs.db 等可变数据隔离到临时目录。
_TEST_ROOT = Path(tempfile.mkdtemp(prefix='meshforge_jobs_test_'))
os.environ['MESHFORGE_DATA_DIR'] = str(_TEST_ROOT)

SERVER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_DIR))

import asyncio  # noqa: E402

from jobstore import JobStore  # noqa: E402
from jobs import JOB_TTL_SECONDS, JobRegistry, JobState  # noqa: E402

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
        # CI：日志正文匿名不可读，输出 ::error:: 让失败明细成为可匿名
        # 读取的 GitHub 注解（优化文档 5.1）。
        print(f'::error::{name}: {type(exc).__name__}: {exc}')


# ─── 用例 ─────────────────────────────────────────────────────────────────────

def test_create_and_get() -> None:
    """创建的任务可按 id 查回，generator_id 一致。"""
    reg = JobRegistry()
    job = reg.create('test-generator')
    got = reg.get(job.job_id)
    assert got is not None
    assert got.generator_id == 'test-generator'
    assert got.state == JobState.PENDING
    assert reg.get('nonexistent-id') is None


def test_request_cancel() -> None:
    """取消标志：存在的任务返回 True 并置位；未知 id 返回 False。"""
    reg = JobRegistry()
    job = reg.create('g')
    assert reg.request_cancel(job.job_id) is True
    assert reg.request_cancel('missing') is False


def test_unknown_generator_fails_and_persists() -> None:
    """run() 遇到未知生成器：任务 FAILED，错误信息写入内存与 jobs.db。"""
    reg = JobRegistry()
    job = reg.create('no-such-generator')
    out_dir = _TEST_ROOT / 'out-unknown'
    asyncio.run(reg.run(job, _TEST_ROOT / 'img.png', out_dir, {}))
    assert job.state == JobState.FAILED
    assert job.error is not None and 'unknown generator' in job.error
    # 终态已同步写入进程级单例指向的 jobs.db（MESHFORGE_DATA_DIR 已重定向）。
    row = reg.get(job.job_id)
    assert row is not None and row.state == JobState.FAILED
    assert row.finished_at is not None


def test_jobstore_roundtrip() -> None:
    """JobStore 独立实例：写入终态后可按 id 查回，recent 按时间倒序。"""
    db = _TEST_ROOT / 'isolated' / 'jobs.db'
    store = JobStore(db)
    now = time.time()
    store.record_terminal(
        job_id='job-a', generator_id='g1', state='succeeded', progress=1.0,
        message='', result_url='/files/job-a/out.glb', error=None,
        created_at=now - 10, finished_at=now,
    )
    store.record_terminal(
        job_id='job-b', generator_id='g1', state='failed', progress=0.5,
        message='', result_url=None, error='boom',
        created_at=now - 5, finished_at=now + 1,
    )
    got = store.get('job-a')
    assert got is not None and got['state'] == 'succeeded'
    assert got['result_url'] == '/files/job-a/out.glb'
    assert store.get('missing') is None
    recent = store.recent()
    assert [r['job_id'] for r in recent] == ['job-b', 'job-a']


def test_ttl_reap() -> None:
    """TTL 清理：过期终态被回收；运行中与未到期的任务保留。"""
    reg = JobRegistry()
    expired = reg.create('g')
    reg.mark_finished(expired, JobState.SUCCEEDED)
    # 把 finished_at 拨回 TTL 之外，模拟"很久以前结束"。
    expired.finished_at = time.time() - JOB_TTL_SECONDS - 60

    fresh = reg.create('g')
    reg.mark_finished(fresh, JobState.FAILED, 'just now')

    running = reg.create('g')
    running.state = JobState.RUNNING  # 运行中：即便字段被滥用也不应被清理

    pending = reg.create('g')  # PENDING 且无 finished_at

    removed = reg.reap_expired()
    assert removed >= 1
    assert reg.get(expired.job_id) is None
    assert reg.get(fresh.job_id) is not None
    assert reg.get(running.job_id) is not None
    assert reg.get(pending.job_id) is not None
    # 再次扫描：无新过期任务，返回 0（幂等）。
    assert reg.reap_expired() == 0


def test_create_persists_pending_row() -> None:
    """create() 同步落库 pending 行：重启恢复的数据链起点。"""
    from jobstore import store as _store_singleton

    reg = JobRegistry()
    job = reg.create('g-recovery')
    row = _store_singleton.get(job.job_id)
    assert row is not None and row['state'] == 'pending'


def test_mark_interrupted_recovers_stale_rows() -> None:
    """mark_interrupted：pending/running 遗留行标记 failed，终态行不动。"""
    db = _TEST_ROOT / 'isolated3' / 'jobs.db'
    store = JobStore(db)
    now = time.time()
    store.upsert_active(job_id='job-p', generator_id='g', state='pending', created_at=now)
    store.upsert_active(job_id='job-r', generator_id='g', state='running', created_at=now)
    store.record_terminal(
        job_id='job-done', generator_id='g', state='succeeded', progress=1.0,
        message='', result_url='/files/x.glb', error=None, created_at=now, finished_at=now,
    )
    ids = store.mark_interrupted('interrupted: backend restarted before the job finished')
    assert sorted(ids) == ['job-p', 'job-r']
    for jid in ('job-p', 'job-r'):
        row = store.get(jid)
        assert row['state'] == 'failed'
        assert 'restarted' in row['error']
        assert row['finished_at'] is not None
    # 终态行不受影响；再次调用无遗留（幂等）。
    assert store.get('job-done')['state'] == 'succeeded'
    assert store.mark_interrupted('x') == []


def test_mark_finished_persists_error() -> None:
    """FAILED 终态的 error 字段经进程级单例 jobstore 落库（重启后仍可查询）。"""
    from jobstore import store as _store_singleton

    reg = JobRegistry()
    job = reg.create('g2')
    reg.mark_finished(job, JobState.FAILED, 'boom: detail')
    row = _store_singleton.get(job.job_id)
    assert row is not None and row['error'] == 'boom: detail' and row['state'] == 'failed'


if __name__ == '__main__':
    for _name, _fn in sorted((n, f) for n, f in globals().items() if n.startswith('test_') and callable(f)):
        check(_name, _fn)
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed, data dir: {_TEST_ROOT}')
    # 独立运行结束后清理临时数据目录。
    import shutil

    shutil.rmtree(_TEST_ROOT, ignore_errors=True)
    sys.exit(1 if failed else 0)
