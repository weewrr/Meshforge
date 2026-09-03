"""Regression test for server/routers/model.py download pipeline.

Self-contained: spins up a local mock "HF Hub" (http.server on 127.0.0.1:8899),
monkeypatches model.py's HF helpers to point at it, then drives the SSE stream
end-to-end: done / skip-if-exists / paused (.part preserved) / cancelled
(.part cleaned) / prefix filtering.

Run from repo root:
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

sys.path.insert(0, r'C:\Users\HELLOWORLD\Desktop\oss\meshforge\server')
from routers import model  # noqa: E402
from generators.registry import MODELS_DIR  # noqa: E402

MOCK_PORT = 8899
MODEL_ID = 'local-test'
DEST = MODELS_DIR / MODEL_ID

REPO_FILES = ['config.json', 'model.safetensors']


def start_mock_server(root: Path) -> ThreadingHTTPServer:
    handler = lambda *a, **kw: SimpleHTTPRequestHandler(*a, directory=str(root), **kw)  # noqa: E731
    server = ThreadingHTTPServer(('127.0.0.1', MOCK_PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def collect(stream_gen):
    chunks = []
    async for c in stream_gen:
        chunks.append(c if isinstance(c, str) else c.decode('utf-8'))
    return chunks


async def collect_marking(stream_gen, started):
    """collect() + set `started` as soon as a real download progress arrives."""
    chunks = []
    async for c in stream_gen:
        text = c if isinstance(c, str) else c.decode('utf-8')
        chunks.append(text)
        if not started.is_set() and 'Downloading' in text:
            started.set()
    return chunks


def parse_events(chunks):
    events = []
    for c in chunks:
        for line in c.splitlines():
            if line.startswith('data: '):
                events.append(json.loads(line[6:]))
    return events


def reset():
    shutil.rmtree(DEST, ignore_errors=True)
    model._download_controls.clear()


async def test_done():
    reset()
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
    # Re-download should short-circuit (files exist)
    reset()
    with mock.patch.object(model, '_list_repo_files', lambda repo, token: list(REPO_FILES)), \
         mock.patch.object(model, 'HF_RESOLVE', f'http://127.0.0.1:{MOCK_PORT}'):
        resp = await model.hf_download(repo_id='x', model_id=MODEL_ID)
        events = parse_events(await collect(resp.body_iterator))
    assert events[-1].get('status') == 'done'
    print(f'[done-redownload] ok, {len(events)} events')


async def test_pause():
    reset()
    started = asyncio.Event()

    async def set_pause_soon():
        # Wait until a real progress event arrives, then pause mid-download.
        await started.wait()
        await asyncio.sleep(0.02)
        ctrl = model._download_controls.get(MODEL_ID)
        if ctrl:
            ctrl['pause'].set()

    # Single 8MB file: pause lands mid-download so a .part must survive.
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
    await test_done()
    await test_pause()
    await test_cancel()
    await test_filter()
    print('\nALL MODEL PIPELINE TESTS PASSED')


if __name__ == '__main__':
    # Set up the in-process mock HF Hub (temp dir + http.server).
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        serve_dir = root / 'x' / 'resolve' / 'main'
        serve_dir.mkdir(parents=True)
        (serve_dir / 'config.json').write_text('{"num_hidden_layers": 2}', encoding='utf-8')
        (serve_dir / 'model.safetensors').write_bytes(b'\x00' * (8 * 1024 * 1024))
        server = start_mock_server(root)
        try:
            asyncio.run(main())
        finally:
            server.shutdown()
            shutil.rmtree(DEST, ignore_errors=True)
