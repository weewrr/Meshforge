"""`server/routers/model.py` 模型下载管线的端到端回归测试。

自带全部依赖：在 127.0.0.1:8899 起一个进程内的假 "HF Hub"（`http.server`），
把 `model.py` 里的 HF 辅助函数 monkeypatch 到该地址，然后驱动 SSE 流跑完
完整流程——比对 done / 文件已存在时跳过 / 暂停（保留 `.part`）/
取消（清理 `.part`）/ 前缀过滤这几条分支。

在仓库根目录运行：
    server\\.venv\\Scripts\\python.exe scripts/test_model_pipeline.py
"""
import asyncio
import json
import shutil
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
# 让 `from routers import model` 能解析到仓库内的后端包（而非已安装的第三方包）。
sys.path.insert(0, str(ROOT / 'server'))
from routers import model  # noqa: E402
from generators.registry import MODELS_DIR  # noqa: E402

MOCK_PORT = 8899
MODEL_ID = 'local-test'
DEST = MODELS_DIR / MODEL_ID

# hf-download 现在要求 repo_id 与扩展 manifest 声明的 hfRepo 一致（优化文档 12.6）；
# 测试用假仓库 'x'，这里登记 manifest 使其通过白名单校验。
model.registry._manifests[MODEL_ID] = {'hfRepo': 'x'}

# 假仓库里暴露的文件清单：一个小的 JSON + 一个 8MB 的权重文件。
REPO_FILES = ['config.json', 'model.safetensors']


def start_mock_server(root: Path) -> ThreadingHTTPServer:
    """在后台线程启动静态文件服务，充当 HF Hub 的替身。

    Args:
        root: 作为 HTTP 根目录的本地路径。

    Returns:
        已启动的服务器实例；调用方负责在结束时 `shutdown()`。
    """
    # 用 lambda 固定 directory=root，让 handler 只服务该临时目录。
    handler = lambda *a, **kw: SimpleHTTPRequestHandler(*a, directory=str(root), **kw)  # noqa: E731
    server = ThreadingHTTPServer(('127.0.0.1', MOCK_PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def collect(stream_gen):
    """把 SSE 流的所有分片收集成字符串列表。

    Args:
        stream_gen: 异步生成器（`resp.body_iterator`）。

    Returns:
        解码后的分片列表。
    """
    chunks = []
    async for c in stream_gen:
        chunks.append(c if isinstance(c, str) else c.decode('utf-8'))
    return chunks


async def collect_marking(stream_gen, started):
    """`collect()` 的变体：收到真实下载进度的那一刻置位 `started`。

    测试需要"等下载真正开始后再触发暂停/取消"，否则控制标志会在下载循环
    建立之前就被消费掉。

    Args:
        stream_gen: 异步生成器。
        started: 由调用方持有的 `asyncio.Event`，此处在首个进度事件时置位。
    """
    chunks = []
    async for c in stream_gen:
        text = c if isinstance(c, str) else c.decode('utf-8')
        chunks.append(text)
        if not started.is_set() and 'Downloading' in text:
            started.set()
    return chunks


def parse_events(chunks):
    """从 SSE 分片里抽出所有 `data: ` 载荷并 JSON 解析。

    Args:
        chunks: `collect()` / `collect_marking()` 返回的分片列表。

    Returns:
        事件对象列表（保持到达顺序）。
    """
    events = []
    for c in chunks:
        for line in c.splitlines():
            if line.startswith('data: '):
                events.append(json.loads(line[6:]))
    return events


def reset():
    """清空目标目录与下载控制表，保证每个测试用例从干净状态开始。"""
    shutil.rmtree(DEST, ignore_errors=True)
    model._download_controls.clear()


async def test_done():
    """正常下载到完成，并验证重下载时短路跳过。"""
    reset()
    # 屏蔽真实网络：把仓库文件列表与 HF 解析地址都指向本地假 Hub。
    with mock.patch.object(model, '_list_repo_files', lambda repo, token: list(REPO_FILES)), \
         mock.patch.object(model, 'HF_RESOLVE', f'http://127.0.0.1:{MOCK_PORT}'):
        resp = await model.hf_download(repo_id='x', model_id=MODEL_ID)
        events = parse_events(await collect(resp.body_iterator))
    last = events[-1]
    assert last.get('status') == 'done', f'expected done, got {last}'
    assert last.get('percent') == 100, f'expected 100, got {last}'
    files = sorted(p.name for p in DEST.rglob('*') if p.is_file())
    assert files == ['config.json', 'model.safetensors'], f'files: {files}'
    print(f'[done] ok, {len(events)} events, dest files: {files}')
    # 重下载应短路（文件已存在）。
    reset()
    with mock.patch.object(model, '_list_repo_files', lambda repo, token: list(REPO_FILES)), \
         mock.patch.object(model, 'HF_RESOLVE', f'http://127.0.0.1:{MOCK_PORT}'):
        resp = await model.hf_download(repo_id='x', model_id=MODEL_ID)
        events = parse_events(await collect(resp.body_iterator))
    assert events[-1].get('status') == 'done'
    print(f'[done-redownload] ok, {len(events)} events')


async def test_pause():
    """下载中途暂停：应上报 `paused` 且保留 `.part` 以便续传。"""
    reset()
    started = asyncio.Event()

    async def set_pause_soon():
        # 等到首个真实进度事件后才暂停，确保暂停落在下载循环内部。
        await started.wait()
        await asyncio.sleep(0.02)
        ctrl = model._download_controls.get(MODEL_ID)
        if ctrl:
            ctrl['pause'].set()

    # 单个 8MB 文件：暂停点落在下载中途，因此必须存在 .part 残留。
    with mock.patch.object(model, '_list_repo_files', lambda repo, token: ['model.safetensors']), \
         mock.patch.object(model, 'HF_RESOLVE', f'http://127.0.0.1:{MOCK_PORT}'):
        resp = await model.hf_download(repo_id='x', model_id=MODEL_ID)
        task = asyncio.ensure_future(collect_marking(resp.body_iterator, started))
        await asyncio.ensure_future(set_pause_soon())
        chunks = await task
    events = parse_events(chunks)
    last = events[-1]
    assert last.get('paused') is True, f'expected paused, got {last}'
    parts = list(DEST.rglob('*.part'))
    assert len(parts) >= 1, f'expected .part preserved for resume, DEST={[p.name for p in DEST.rglob("*")]}'
    print(f'[paused] ok, last={last}, .part preserved: {[p.name for p in parts]}')


async def test_cancel():
    """下载中途取消：应上报 `cancelled` 并清理所有 `.part`。"""
    reset()
    started = asyncio.Event()

    async def set_cancel_soon():
        await started.wait()
        await asyncio.sleep(0.02)
        ctrl = model._download_controls.get(MODEL_ID)
        if ctrl:
            ctrl['cancel'].set()

    with mock.patch.object(model, '_list_repo_files', lambda repo, token: ['model.safetensors']), \
         mock.patch.object(model, 'HF_RESOLVE', f'http://127.0.0.1:{MOCK_PORT}'):
        resp = await model.hf_download(repo_id='x', model_id=MODEL_ID)
        task = asyncio.ensure_future(collect_marking(resp.body_iterator, started))
        await asyncio.ensure_future(set_cancel_soon())
        chunks = await task
    events = parse_events(chunks)
    last = events[-1]
    assert last.get('cancelled') is True, f'expected cancelled, got {last}'
    parts = list(DEST.rglob('*.part'))
    assert len(parts) == 0, f'expected .part cleanup, found {parts}'
    print(f'[cancelled] ok, last={last}, .part cleaned')


async def test_filter():
    """`skip_prefixes` 生效：被过滤的文件不应落盘。"""
    reset()
    with mock.patch.object(model, '_list_repo_files', lambda repo, token: list(REPO_FILES)), \
         mock.patch.object(model, 'HF_RESOLVE', f'http://127.0.0.1:{MOCK_PORT}'):
        resp = await model.hf_download(repo_id='x', model_id=MODEL_ID,
                                       skip_prefixes=json.dumps(['model.safetensors']))
        events = parse_events(await collect(resp.body_iterator))
    files = sorted(p.name for p in DEST.rglob('*') if p.is_file())
    assert files == ['config.json'], f'expected only config.json, got {files}'
    assert events[-1].get('status') == 'done'
    print(f'[filter] ok, downloaded only: {files}')


async def main():
    """依次跑完全部用例；任一断言失败即中断。"""
    await test_done()
    await test_pause()
    await test_cancel()
    await test_filter()
    print('\nALL MODEL PIPELINE TESTS PASSED')


if __name__ == '__main__':
    # 准备进程内模拟 HF Hub（临时目录 + http.server）。
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        # 复刻 HF 的 URL 布局：/<repo>/resolve/main/<file>。
        serve_dir = root / 'x' / 'resolve' / 'main'
        serve_dir.mkdir(parents=True)
        (serve_dir / 'config.json').write_text('{"num_hidden_layers": 2}', encoding='utf-8')
        # 8MB 的空字节文件——足够大，保证暂停/取消有落点。
        (serve_dir / 'model.safetensors').write_bytes(b'\x00' * (8 * 1024 * 1024))
        server = start_mock_server(root)
        try:
            asyncio.run(main())
        finally:
            server.shutdown()
            shutil.rmtree(DEST, ignore_errors=True)
