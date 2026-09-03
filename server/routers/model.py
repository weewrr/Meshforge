"""Model weight downloads (HuggingFace Hub → MODELS_DIR/<ext_id>/).

This is the meshforge counterpart of Modly's api/routers/model.py. The Modly
reference streams with huggingface_hub; this venv is stdlib-only, so listing
and downloading are implemented with urllib against the public HF Hub API:

  * list files:  GET https://huggingface.co/api/models/{repo_id}
                 → {"siblings": [{"rfilename": "..."}]}
  * download:    GET https://huggingface.co/{repo_id}/resolve/main/{filename}
                 with optional `Range: bytes=N-` for resume.

Endpoints
  GET  /model/status                 → download state of every hf-backed model
  GET  /model/hf-download            → SSE stream (percent/file/status events)
  POST /model/hf-download/pause      → pause the active download (body: {id})
  POST /model/hf-download/cancel     → cancel + delete .part files (body: {id})

Control keys are "<ext_id>" (one model per extension in meshforge). Pause is
resumable: the stream ends with a `paused` event, .part files are kept, and
the next download call resumes via Range.
"""

import asyncio
import json
import os
import re
import socket
import threading
import time
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from generators.registry import MODELS_DIR, registry

router = APIRouter(prefix='/model', tags=['model'])

HF_API = 'https://huggingface.co/api/models'
HF_RESOLVE = 'https://huggingface.co'
USER_AGENT = 'meshforge/0.1.0'


class DownloadPaused(Exception):
    pass


class DownloadCancelled(Exception):
    pass


# ─── Pause / cancel controls ─────────────────────────────────────────────────

_download_controls: dict[str, dict[str, threading.Event]] = {}


def _new_download_control(model_id: str) -> dict[str, threading.Event]:
    control: dict[str, threading.Event] = {'pause': threading.Event(), 'cancel': threading.Event()}
    _download_controls[model_id] = control
    return control


def _check_download_control(control: dict[str, threading.Event]) -> None:
    if control['cancel'].is_set():
        raise DownloadCancelled()
    if control['pause'].is_set():
        raise DownloadPaused()


def _safe_model_dir(model_id: str) -> Path:
    if not re.match(r'^[A-Za-z0-9_-]{1,64}$', model_id):
        raise HTTPException(status_code=400, detail='invalid model id')
    return (MODELS_DIR / model_id).resolve()


# ─── Status ──────────────────────────────────────────────────────────────────

@router.get('/status')
async def model_status() -> dict:
    """Download state of every model extension that declares an HF repo.

    The frontend merges this by extension id to show Install / Installed /
    download progress. `sizeBytes` is the on-disk size of the model folder
    (0 when nothing has been downloaded yet).
    """
    models = []
    for ext_id, manifest in registry._manifests.items():
        repo = manifest.get('hfRepo') or manifest.get('hf_repo')
        if not repo:
            continue
        if str(manifest.get('kind') or 'model') != 'model':
            continue
        folder = _safe_model_dir(ext_id)
        size = 0
        downloaded = False
        if folder.is_dir():
            size = sum(p.stat().st_size for p in folder.rglob('*') if p.is_file())
            downloaded = any(p.suffix != '.part' for p in folder.rglob('*') if p.is_file())
        models.append({
            'extId': ext_id,
            'repoId': repo,
            'skipPrefixes': manifest.get('hf_skip_prefixes') or manifest.get('hfSkipPrefixes') or [],
            'includePrefixes': manifest.get('hf_include_prefixes') or manifest.get('hfIncludePrefixes') or [],
            'downloaded': downloaded,
            'sizeBytes': size,
        })
    return {'models': models}


# ─── HF Hub helpers (urllib only) ────────────────────────────────────────────

def _request(url: str, headers: dict, method: str = 'GET') -> object:
    req = Request(url, headers=headers, method=method)
    return urlopen(req, timeout=30)


def _list_repo_files(repo_id: str, token: Optional[str]) -> list[str]:
    """List files in an HF repo via the public API (no huggingface_hub)."""
    headers = {'User-Agent': USER_AGENT}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    with _request(f'{HF_API}/{repo_id}', headers) as resp:
        payload = json.loads(resp.read().decode('utf-8'))
    siblings = payload.get('siblings') or []
    return [s.get('rfilename') for s in siblings if s.get('rfilename')]


def _download_status(downloaded: int, total: Optional[int], attempt: int, retries: int, resumed: bool = False) -> str:
    prefix = 'Resuming…' if resumed and downloaded > 0 else 'Downloading…'
    if total and total > 0:
        pct = min(100, round(downloaded / total * 100))
        return f'{prefix} {pct}%'
    if retries > 1 and attempt > 1:
        return f'{prefix} retry {attempt}/{retries}'
    return prefix


def _response_total_bytes(headers, already_downloaded: int) -> Optional[int]:
    content_range = headers.get('Content-Range')
    if content_range and '/' in content_range:
        try:
            return int(content_range.split('/')[-1].strip())
        except (TypeError, ValueError):
            pass
    raw = headers.get('Content-Length')
    if raw is None:
        return None
    try:
        return already_downloaded + int(raw)
    except (TypeError, ValueError):
        return None


def _download_file_streamed(
    *,
    url: str,
    filename: str,
    dest_dir: Path,
    file_index: int,
    total_files: int,
    base_percent: int,
    progress_cb,
    control: dict[str, threading.Event],
    token: Optional[str] = None,
) -> int:
    """Download a single file into dest_dir with resume + pause/cancel checks."""
    final_path = dest_dir / filename
    temp_path = final_path.with_suffix(final_path.suffix + '.part')
    final_path.parent.mkdir(parents=True, exist_ok=True)

    if final_path.exists():
        return final_path.stat().st_size

    headers = {'User-Agent': USER_AGENT}
    if token:
        headers['Authorization'] = f'Bearer {token}'

    retries = 3
    backoff = 2.0
    last_error: Optional[Exception] = None

    for attempt in range(1, retries + 1):
        try:
            _check_download_control(control)
            existing_bytes = temp_path.stat().st_size if temp_path.exists() else 0
            request_headers = dict(headers)
            request_url = url
            if existing_bytes > 0:
                request_url = _resolve_direct_download_url(url, headers)
                request_headers['Range'] = f'bytes={existing_bytes}-'

            with urlopen(Request(request_url, headers=request_headers), timeout=30) as response:
                status = getattr(response, 'status', None)
                resumed = existing_bytes > 0 and status == 206
                if existing_bytes > 0 and not resumed:
                    temp_path.unlink(missing_ok=True)
                    existing_bytes = 0

                total_bytes = _response_total_bytes(response.headers, existing_bytes if resumed else 0)
                bytes_downloaded = existing_bytes
                last_emit = 0.0
                chunk_size = 1024 * 1024
                mode = 'ab' if resumed else 'wb'

                progress_cb({
                    'percent': base_percent,
                    'file': filename,
                    'fileIndex': file_index,
                    'totalFiles': total_files,
                    'status': _download_status(bytes_downloaded, total_bytes, attempt, retries, resumed=resumed),
                    'bytesDownloaded': bytes_downloaded,
                    'totalBytes': total_bytes,
                    'stalledSeconds': 0,
                })

                with temp_path.open(mode) as out:
                    while True:
                        _check_download_control(control)
                        try:
                            chunk = response.read(chunk_size)
                        except socket.timeout as exc:
                            raise TimeoutError(f'Timed out while downloading {filename}') from exc
                        if not chunk:
                            break
                        out.write(chunk)
                        bytes_downloaded += len(chunk)

                        now = time.monotonic()
                        if now - last_emit >= 0.5:
                            progress_cb({
                                'percent': base_percent,
                                'file': filename,
                                'fileIndex': file_index,
                                'totalFiles': total_files,
                                'status': _download_status(bytes_downloaded, total_bytes, attempt, retries, resumed=resumed),
                                'bytesDownloaded': bytes_downloaded,
                                'totalBytes': total_bytes,
                                'stalledSeconds': 0,
                            })
                            last_emit = now

            temp_path.replace(final_path)
            return bytes_downloaded

        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_error = exc
            preserved_bytes = temp_path.stat().st_size if temp_path.exists() else 0
            progress_cb({
                'percent': base_percent,
                'file': filename,
                'fileIndex': file_index,
                'totalFiles': total_files,
                'status': f'Retrying after error ({attempt}/{retries})…',
                'bytesDownloaded': preserved_bytes,
                'stalledSeconds': 0,
            })
            if attempt >= retries:
                break
            time.sleep(backoff)
            backoff *= 2

    raise RuntimeError(f'Failed to download {filename}: {last_error}')


def _resolve_direct_download_url(url: str, headers: dict[str, str]) -> str:
    """HEAD request: follow redirects to the final CDN URL (for Range resume)."""
    with urlopen(Request(url, headers=headers, method='HEAD'), timeout=30) as response:
        return response.geturl()


# ─── Pause / cancel endpoints ────────────────────────────────────────────────

class DownloadControlBody(BaseModel):
    id: str


@router.post('/hf-download/pause')
async def pause_hf_download(body: DownloadControlBody) -> dict:
    control = _download_controls.get(body.id)
    if control is None:
        return {'paused': False, 'message': 'no active download'}
    control['pause'].set()
    return {'paused': True}


@router.post('/hf-download/cancel')
async def cancel_hf_download(body: DownloadControlBody) -> dict:
    control = _download_controls.get(body.id)
    if control is None:
        return {'cancelled': False, 'message': 'no active download'}
    control['cancel'].set()
    return {'cancelled': True}


# ─── SSE download stream ─────────────────────────────────────────────────────

@router.get('/hf-download')
async def hf_download(
    repo_id: str,
    model_id: str,
    skip_prefixes: Optional[str] = None,
    include_prefixes: Optional[str] = None,
    token: Optional[str] = None,
):
    """Stream a HuggingFace Hub model download via SSE.

    Downloads into MODELS_DIR / model_id, applying the filter declared in the
    extension manifest (hf_skip_prefixes / hf_include_prefixes).

    SSE data events: {"percent": 0-100, "file": "...", "status": "..."}
    Terminal events: done / paused / cancelled / error
    """
    dest_dir = _safe_model_dir(model_id)

    def _list(prefixes: Optional[str], fallback: list) -> list:
        if prefixes:
            try:
                return json.loads(prefixes)
            except Exception:
                return []
        return fallback

    skip_list = _list(skip_prefixes, registry.get_manifest(model_id).get('hf_skip_prefixes') or [])
    include_list = _list(include_prefixes, registry.get_manifest(model_id).get('hf_include_prefixes') or [])

    hf_token = token or os.environ.get('HUGGING_FACE_HUB_TOKEN') or os.environ.get('HF_TOKEN') or None
    control = _new_download_control(model_id)

    async def stream():
        loop = asyncio.get_running_loop()

        def _fmt(data: dict) -> str:
            return f'data: {json.dumps(data)}\n\n'

        try:
            yield _fmt({'percent': 0, 'status': 'Listing repository files...'})
            _check_download_control(control)

            files = await loop.run_in_executor(
                None,
                lambda: [
                    f for f in _list_repo_files(repo_id, hf_token)
                    if (not include_list or any(f.startswith(p) for p in include_list))
                    if not any(f.startswith(p) for p in skip_list)
                ],
            )
            total = len(files)

            if total == 0:
                yield _fmt({'error': f'No files found in HuggingFace repo: {repo_id}'})
                return

            yield _fmt({'percent': 1, 'status': f'Downloading {total} files...'})

            for i, filename in enumerate(files):
                _check_download_control(control)
                base_pct = 1 + round(i / total * 94)
                yield _fmt({
                    'percent': base_pct,
                    'file': filename,
                    'fileIndex': i + 1,
                    'totalFiles': total,
                    'status': f'Starting {filename}',
                    'bytesDownloaded': 0,
                    'stalledSeconds': 0,
                })

                queue: asyncio.Queue[dict] = asyncio.Queue()

                def _progress(msg: dict) -> None:
                    loop.call_soon_threadsafe(queue.put_nowait, msg)

                url = f'{HF_RESOLVE}/{repo_id}/resolve/main/{filename}'
                dl_future = loop.run_in_executor(
                    None,
                    lambda: _download_file_streamed(
                        url=url,
                        filename=filename,
                        dest_dir=dest_dir,
                        file_index=i + 1,
                        total_files=total,
                        base_percent=base_pct,
                        progress_cb=_progress,
                        control=control,
                        token=hf_token,
                    ),
                )

                while not dl_future.done():
                    try:
                        msg = await asyncio.wait_for(queue.get(), timeout=2.0)
                    except asyncio.TimeoutError:
                        continue
                    else:
                        yield _fmt(msg)

                final_size = await dl_future
                _check_download_control(control)

                pct = 1 + round((i + 1) / total * 94)
                yield _fmt({
                    'percent': pct,
                    'file': filename,
                    'fileIndex': i + 1,
                    'totalFiles': total,
                    'status': 'Downloaded',
                    'bytesDownloaded': final_size,
                    'stalledSeconds': 0,
                })

            yield _fmt({'percent': 100, 'status': 'done'})

        except DownloadPaused:
            yield _fmt({'paused': True, 'status': 'paused'})
        except DownloadCancelled:
            # Remove only partial files; completed files are preserved so the
            # next download can resume from where it left off.
            for part in dest_dir.rglob('*.part'):
                part.unlink(missing_ok=True)
            yield _fmt({'cancelled': True, 'status': 'cancelled'})
        except Exception as exc:  # noqa: BLE001 - SSE streams surface errors as events
            yield _fmt({'error': str(exc)})
        finally:
            # Only remove the control if it still belongs to this session.
            if _download_controls.get(model_id) is control:
                _download_controls.pop(model_id, None)

    return StreamingResponse(stream(), media_type='text/event-stream')
