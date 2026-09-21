"""模型下载路由：模型卡片清单状态 + 经 ModelScope CLI 的权重下载（SSE）。

设置页"模型下载"分区调用；下载逻辑与清单见 `server/model_downloads.py`。

接口：
  GET  /model-services/download/status   → modelscope 可用性 + 每个服务的安装态
  POST /model-services/download/{key}    → SSE（status 事件，done/error 收尾）
"""

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from config import SERVICES_ROOT
from model_downloads import (
    MODELS_ROOT,
    PROFILES,
    _installed_state,
    _modelscope_cli,
    modelscope_version,
    profile,
)

router = APIRouter(prefix='/model-services/download', tags=['model-services'])


@router.get('/status')
async def download_status() -> dict:
    """返回模型的安装态与 modelscope CLI 可用性，供设置页渲染卡片清单。

    Returns:
        ``{'modelscopeAvailable': bool, 'modelscopeVersion': str|null,
        'services': [{key,label,modelscopeId,hfRef,localDir,installed,sizeBytes}]}``
    """
    services = []
    for p in PROFILES:
        installed, size = _installed_state(p)
        services.append({
            'key': p.key,
            'label': p.label,
            'modelscopeId': p.modelscope_id,
            'hfRef': p.hf_ref,
            'localDir': p.local_rel,
            'installed': installed,
            'sizeBytes': size,
            'root': str(MODELS_ROOT / p.local_rel),
        })
    return {
        'modelscopeAvailable': modelscope_version() is not None,
        'modelscopeVersion': modelscope_version(),
        'services': services,
    }


# modelscope CLI 启动时会打印一段 ASCII art banner（约 11 行）。特征串取自实测
# 输出，且只用于"见到第一条真实输出之前"的起始段，避免误伤后续正文。
_BANNER_MARKERS = (".-')", "( OO", "OO )", "('-.", "\\_)", "'---", "---'", "--'")


def _is_banner_line(text: str) -> bool:
    """判断是否为 modelscope 启动时打印的 ASCII banner 行。"""
    return any(marker in text for marker in _BANNER_MARKERS)


def _clean_output(raw: bytes, banner_phase: bool) -> tuple[list[str], bool]:
    """把一段 modelscope 原始输出规整成待转发的行。

    Args:
        raw: 原始字节块。
        banner_phase: 是否仍处于"尚未见到真实输出"的起始段。

    Returns:
        ``(待转发的行, 新的 banner_phase)``。

    tqdm 用 ``\\r`` 原地刷新，一个逻辑行里会挤进多个进度快照，这里只保留最新
    一段——既避免前端刷屏，也保住 ``README.md → <path>`` 这类收尾行。
    """
    out: list[str] = []
    for line in raw.split(b'\n'):
        segments = [s.strip() for s in line.decode('utf-8', 'replace').split('\r') if s.strip()]
        if not segments:
            continue
        text = segments[-1]
        if banner_phase:
            if _is_banner_line(text):
                continue
            banner_phase = False
        out.append(text)
    return out, banner_phase


async def _modelscope_download_stream(key: str):
    """运行 `modelscope download` 并把它 stdout/stderr 转成 SSE 事件。"""
    p = profile(key)
    if p is None:
        yield _fmt({'error': f'unknown model key: {key}'})
        return
    cli = _modelscope_cli()
    if cli is None:
        yield _fmt({'error': 'modelscope 未安装：请先 `pip install modelscope`（或使用含该依赖的打包版）'})
        return
    if p.modelscope_id is None:
        yield _fmt({'error': f'{p.label} 在 ModelScope 上无单一权重仓库，请按 README 手动放置到 {MODELS_ROOT / p.local_rel}'})
        return

    target = MODELS_ROOT / p.local_rel
    target.mkdir(parents=True, exist_ok=True)

    # files 是 modelscope 的位置参数：留空表示整仓快照，指定则只下这些路径。
    cmd = [str(cli), 'download', '--model', p.modelscope_id, *p.files, '--local_dir', str(target)]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(SERVICES_ROOT),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=1024 * 1024,
        )
    except OSError as exc:  # pragma: no cover - 极端环境兜底
        yield _fmt({'error': f'failed to start modelscope: {exc}'})
        return

    yield _fmt({'status': f'下载中：{p.modelscope_id} → {p.local_rel}'})

    assert proc.stdout is not None
    buffer = b''
    banner_phase = True
    while True:
        chunk = await proc.stdout.read(64 * 1024)
        if not chunk:
            break
        buffer += chunk
        lines = buffer.split(b'\n')
        buffer = lines.pop()
        events, banner_phase = _clean_output(b'\n'.join(lines), banner_phase)
        for text in events:
            yield _fmt({'status': text})

    # 收尾：末尾可能只剩一段没有以 \n 结束的输出。
    events, banner_phase = _clean_output(buffer, banner_phase)
    for text in events:
        yield _fmt({'status': text})

    rc = await proc.wait()
    if rc == 0:
        yield _fmt({'status': '完成', 'done': True})
    else:
        yield _fmt({'error': f'modelscope 退出码 {rc}'})


def _fmt(data: dict) -> str:
    return f'data: {json.dumps(data)}\n\n'


@router.post('/{key}')
async def model_download(key: str):
    """以 SSE 流式调用 ModelScope CLI 下载指定服务的权重。

    SSE 数据事件：`{"status": "..."}`（modelscope 输出行）。
    终止事件：`{"done": true}` 或 `{"error": "..."}`。
    """
    if profile(key) is None:
        raise HTTPException(status_code=400, detail='unknown model key')
    return StreamingResponse(_modelscope_download_stream(key), media_type='text/event-stream')