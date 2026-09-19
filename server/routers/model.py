"""模型权重下载（HuggingFace Hub → MODELS_DIR/<ext_id>/）。

这是 Modly 的 api/routers/model.py 在 meshforge 中的对应实现。Modly 参考实现
用 huggingface_hub 做流式下载；而本 venv 只带标准库，所以列表与下载都用
urllib 直接打公开的 HF Hub API：

  * 列文件：GET https://huggingface.co/api/models/{repo_id}
            → {"siblings": [{"rfilename": "..."}]}
  * 下载：  GET https://huggingface.co/{repo_id}/resolve/main/{filename}
            可选 `Range: bytes=N-` 实现断点续传。

接口
  GET  /model/status                 → 每个 hf 模型扩展的下载状态
  GET  /model/hf-download            → SSE 流（percent/file/status 事件）
  POST /model/hf-download/pause      → 暂停当前下载（body: {id}）
  POST /model/hf-download/cancel     → 取消并删除 .part 文件（body: {id}）

控制键就是 "<ext_id>"（meshforge 里一个扩展对应一个模型）。暂停是可续传的：
流会以 `paused` 事件收尾，.part 文件保留，下一次下载调用用 Range 接着下。
"""

import asyncio
import json
import os
import re
import socket
import threading
from pathlib import Path, PureWindowsPath
import time
from http import HTTPStatus
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from generators.registry import MODELS_DIR, registry

router = APIRouter(prefix='/model', tags=['model'])

HF_API = 'https://huggingface.co/api/models'
HF_RESOLVE = 'https://huggingface.co'
USER_AGENT = 'meshforge/0.1.0'
# SSE 进度事件的最小发送间隔（秒），避免高频 flush 拖慢下载本身。
PROGRESS_EMIT_INTERVAL_S = 0.5
# 下载阶段占用进度条的 1..(1+SPAN)%，剩余留给"落盘 / 校验"收尾。
DOWNLOAD_PCT_SPAN = 94


# 暂停信号：在下载循环中被 `_check_download_control` 抛出。
class DownloadPaused(Exception):
    pass


# 取消信号：在下载循环中被 `_check_download_control` 抛出。
class DownloadCancelled(Exception):
    pass


# ─── 暂停 / 取消控制 ─────────────────────────────────────────────────────────

# 每个 model_id 一组 Event（pause / cancel）；下载线程与 HTTP 处理器之间靠它通信。
_download_controls: dict[str, dict[str, threading.Event]] = {}


def _new_download_control(model_id: str) -> dict[str, threading.Event]:
    """为某个模型新建一组控制 Event，并登记到全局表（覆盖旧的同名项）。"""
    control: dict[str, threading.Event] = {'pause': threading.Event(), 'cancel': threading.Event()}
    _download_controls[model_id] = control
    return control


def _check_download_control(control: dict[str, threading.Event]) -> None:
    """检查控制信号：取消优先于暂停。

    Raises:
        DownloadCancelled: 收到取消信号。
        DownloadPaused: 收到暂停信号。
    """
    if control['cancel'].is_set():
        raise DownloadCancelled()
    if control['pause'].is_set():
        raise DownloadPaused()


def _safe_model_dir(model_id: str) -> Path:
    """把 model_id 解析为 MODELS_DIR/<id> 的绝对路径。

    Raises:
        HTTPException: id 不符合白名单规则（400）。
    """
    if not re.match(r'^[A-Za-z0-9_-]{1,64}$', model_id):
        raise HTTPException(status_code=400, detail='invalid model id')
    return (MODELS_DIR / model_id).resolve()


def _safe_dest_path(dest_dir: Path, filename: str) -> Path:
    """校验远端文件清单里的相对路径并解析为模型目录内的绝对路径。

    防御性校验（优化文档 12.6）：远端清单是外部输入，文件名里若出现
    绝对路径、`..` 段或解析后逃出模型目录的路径，一律拒绝——否则
    恶意/被篡改的仓库可以把文件写到模型目录之外的任意位置。

    Raises:
        ValueError: 路径不安全。
    """
    rel = Path(filename)
    # 双视角校验：服务可能跑在 POSIX 或 Windows 上，远端清单是外部输入，
    # Windows 形态的绝对路径（C:/x、\\srv\share）与反斜杠 `..` 在 POSIX
    # 视角下不是分隔符、会被误当相对文件名放行——任一视角下为绝对路径
    # 或含 `..` 段一律拒绝（CI 在 Linux 上跑，test_paths 的断言两平台一致）。
    if (
        rel.is_absolute()
        or '..' in rel.parts
        or PureWindowsPath(filename).is_absolute()
        or '..' in PureWindowsPath(filename).parts
    ):
        raise ValueError(f'unsafe path in repo file list: {filename}')
    final = (dest_dir / rel).resolve()
    if not final.is_relative_to(dest_dir.resolve()):
        raise ValueError(f'path escapes model dir: {filename}')
    return final


# ─── 状态 ────────────────────────────────────────────────────────────────────

@router.get('/status')
async def model_status() -> dict:
    """每个声明了 HF 仓库的模型扩展的下载状态。

    前端按扩展 id 合并这份数据，用来显示 安装 / 已安装 / 下载进度。
    `sizeBytes` 是模型目录的磁盘占用（尚未下载任何东西时为 0）。

    Returns:
        `{'models': [{extId, repoId, skipPrefixes, includePrefixes,
        downloaded, sizeBytes}, ...]}`。
    """
    models = []
    for ext_id, manifest in registry._manifests.items():
        # 兼容两种键名写法（camelCase / snake_case）。
        repo = manifest.get('hfRepo') or manifest.get('hf_repo')
        if not repo:
            continue
        # 只有 model 类扩展才会有权重下载；process 类工具是本地的。
        if str(manifest.get('kind') or 'model') != 'model':
            continue
        folder = _safe_model_dir(ext_id)
        size = 0
        downloaded = False
        if folder.is_dir():
            size = sum(p.stat().st_size for p in folder.rglob('*') if p.is_file())
            # 只要存在非 .part 的文件就认为"下过东西了"（半成品不算完成）。
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


# ─── HF Hub 辅助（仅用 urllib） ──────────────────────────────────────────────

def _request(url: str, headers: dict, method: str = 'GET') -> object:
    """发一个带 UA / 鉴权头的 HTTP 请求（30s 超时），返回响应对象。"""
    req = Request(url, headers=headers, method=method)
    return urlopen(req, timeout=30)


def _list_repo_files(repo_id: str, token: Optional[str]) -> list[str]:
    """通过公开 API 列出 HF 仓库里的文件（不依赖 huggingface_hub）。

    Args:
        repo_id: 'owner/repo'。
        token: 可选 HF token（私有仓库 / 提高配额时用）。

    Returns:
        仓库内的文件相对路径列表。
    """
    headers = {'User-Agent': USER_AGENT}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    with _request(f'{HF_API}/{repo_id}', headers) as resp:
        payload = json.loads(resp.read().decode('utf-8'))
    siblings = payload.get('siblings') or []
    return [s.get('rfilename') for s in siblings if s.get('rfilename')]


def _download_status(downloaded: int, total: Optional[int], attempt: int, retries: int, resumed: bool = False) -> str:
    """拼给前端看的下载状态文案（含百分比或重试次数）。

    Args:
        downloaded: 已下载字节数。
        total: 总字节数；None 表示服务端未给出。
        attempt: 当前第几次尝试。
        retries: 最大尝试次数。
        resumed: 本次是否为断点续传。

    Returns:
        形如 'Downloading… 42%' / 'Resuming… retry 2/3' 的字符串。
    """
    prefix = 'Resuming…' if resumed and downloaded > 0 else 'Downloading…'
    if total and total > 0:
        # 夹到 100：服务端 total 可能比实际略小，避免出现 101%。
        pct = min(100, round(downloaded / total * 100))
        return f'{prefix} {pct}%'
    if retries > 1 and attempt > 1:
        return f'{prefix} retry {attempt}/{retries}'
    return prefix


def _response_total_bytes(headers, already_downloaded: int) -> Optional[int]:
    """从响应头推算文件总字节数。

    优先用 `Content-Range`（断点续传时它给的是完整文件大小）；否则用
    `Content-Length` 加上已下载的部分。

    Returns:
        总字节数；无法解析时返回 None。
    """
    content_range = headers.get('Content-Range')
    if content_range and '/' in content_range:
        try:
            # Content-Range 形如 'bytes 100-999/1000'，取斜杠后的总数。
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
    """把单个文件下载到 dest_dir，支持断点续传 + 暂停/取消检查。

    关键设计：先写 `.part` 临时文件，全部下完才 `replace` 成正式文件——
    这样中途失败/取消都不会留下一个"看起来完整"的半成品。

    Args:
        url: 文件的 HF resolve 地址。
        filename: 仓库内相对路径（决定落盘位置）。
        dest_dir: 目标模型目录。
        file_index: 当前是第几个文件（从 1 开始，仅用于进度事件）。
        total_files: 文件总数（仅用于进度事件）。
        base_percent: 该文件对应的进度基准值。
        progress_cb: 进度回调，接收一个 dict。
        control: 暂停/取消控制 Event。
        token: 可选 HF token。

    Returns:
        该文件最终的字节数。

    Raises:
        RuntimeError: 重试耗尽后仍然失败。
    """
    final_path = _safe_dest_path(dest_dir, filename)
    # 临时文件用 '.part' 后缀：状态接口据此区分"完整文件"与"半成品"。
    temp_path = final_path.with_suffix(final_path.suffix + '.part')
    final_path.parent.mkdir(parents=True, exist_ok=True)

    # 已存在同名正式文件则视为已下载，直接返回大小（支持增量补全）。
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
                # 先 HEAD 拿到最终 CDN 地址：resolve 会 302，直接带 Range 去请求
                # 重定向前的地址时，部分 CDN 会忽略 Range 返回整个文件。
                request_url = _resolve_direct_download_url(url, headers)
                request_headers['Range'] = f'bytes={existing_bytes}-'

            with urlopen(Request(request_url, headers=request_headers), timeout=30) as response:
                status = getattr(response, 'status', None)
                resumed = existing_bytes > 0 and status == HTTPStatus.PARTIAL_CONTENT
                # 服务端没按 206 返回（不支持 Range）：丢弃残留的 .part 重新下。
                if existing_bytes > 0 and not resumed:
                    temp_path.unlink(missing_ok=True)
                    existing_bytes = 0

                total_bytes = _response_total_bytes(response.headers, existing_bytes if resumed else 0)
                bytes_downloaded = existing_bytes
                last_emit = 0.0
                chunk_size = 1024 * 1024
                # 续传用追加模式，全新下载用覆盖模式。
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

                        # 节流：1MB 分块下若不节流会每秒产生上百个 SSE 事件。
                        now = time.monotonic()
                        if now - last_emit >= PROGRESS_EMIT_INTERVAL_S:
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

            # 原子替换：此刻起这个文件才算"下载完成"。
            temp_path.replace(final_path)
            return bytes_downloaded

        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_error = exc
            # 保留已下的字节：下一轮可用 Range 续传，不必从头再来。
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
            # 指数退避：2s → 4s → 8s。
            backoff *= 2

    raise RuntimeError(f'Failed to download {filename}: {last_error}')


def _resolve_direct_download_url(url: str, headers: dict[str, str]) -> str:
    """发 HEAD 请求，跟到最终 CDN 地址（供 Range 续传使用）。"""
    with urlopen(Request(url, headers=headers, method='HEAD'), timeout=30) as response:
        return response.geturl()


# ─── 暂停 / 取消接口 ─────────────────────────────────────────────────────────

class DownloadControlBody(BaseModel):
    """暂停 / 取消请求体。"""

    id: str


@router.post('/hf-download/pause')
async def pause_hf_download(body: DownloadControlBody) -> dict:
    """暂停指定模型的下载。

    只是置位 Event；实际的暂停发生在下载线程下一次检查控制信号时。
    因此 .part 文件与进度都会保留，可后续续传。
    """
    control = _download_controls.get(body.id)
    if control is None:
        return {'paused': False, 'message': 'no active download'}
    control['pause'].set()
    return {'paused': True}


@router.post('/hf-download/cancel')
async def cancel_hf_download(body: DownloadControlBody) -> dict:
    """取消指定模型的下载（流侧会顺带清掉 .part 文件）。"""
    control = _download_controls.get(body.id)
    if control is None:
        return {'cancelled': False, 'message': 'no active download'}
    control['cancel'].set()
    return {'cancelled': True}


# ─── SSE 下载流 ──────────────────────────────────────────────────────────────

@router.get('/hf-download')
async def hf_download(
    repo_id: str,
    model_id: str,
    skip_prefixes: Optional[str] = None,
    include_prefixes: Optional[str] = None,
    x_hf_token: Optional[str] = Header(default=None, alias='X-HF-Token'),
):
    """以 SSE 流式下载一个 HuggingFace Hub 模型。

    下载到 MODELS_DIR / model_id，并按扩展 manifest 里声明的过滤规则执行
    （hf_skip_prefixes / hf_include_prefixes）。

    SSE 数据事件：{"percent": 0-100, "file": "...", "status": "..."}
    终止事件：done / paused / cancelled / error

    Args:
        repo_id: HF 仓库 id（'owner/repo'）；必须与扩展 manifest 声明的
            hfRepo 一致，未声明或不相符的仓库一律拒绝下载。
        model_id: 扩展 id，决定落盘目录。
        skip_prefixes: JSON 数组字符串，覆盖 manifest 里的排除前缀。
        include_prefixes: JSON 数组字符串，覆盖 manifest 里的包含前缀。
        x_hf_token: `X-HF-Token` 请求头（FastAPI 注入）——HF token 不再走
            URL query，避免进入访问日志 / 浏览器历史 / 代理日志（文档 12.6 / 13.3）。
    """
    dest_dir = _safe_model_dir(model_id)

    # repo 白名单校验：只允许下载 manifest 明确声明过的仓库，
    # 防止后端被当作任意 HF 仓库的下载代理。
    manifest = registry.get_manifest(model_id)
    declared_repo = manifest.get('hfRepo') or manifest.get('hf_repo')
    if not declared_repo:
        raise HTTPException(status_code=400, detail=f"model '{model_id}' does not declare an hfRepo; download not allowed")
    if repo_id != declared_repo:
        raise HTTPException(status_code=400, detail=f'repo_id must match the extension manifest: {declared_repo}')

    def _list(prefixes: Optional[str], fallback: list) -> list:
        """解析查询参数里的 JSON 前缀列表；解析失败或为空则用 manifest 的默认值。"""
        if prefixes:
            try:
                return json.loads(prefixes)
            except Exception:
                return []
        return fallback

    skip_list = _list(skip_prefixes, registry.get_manifest(model_id).get('hf_skip_prefixes') or [])
    include_list = _list(include_prefixes, registry.get_manifest(model_id).get('hf_include_prefixes') or [])

    # token 来源：X-HF-Token 请求头 → 两个常见的 HF token 环境变量名。
    # isinstance 守卫：直接函数调用（单测）拿到的默认值是 Header 实例而非字符串。
    header_token = x_hf_token.strip() if isinstance(x_hf_token, str) else ''
    hf_token = header_token or os.environ.get('HUGGING_FACE_HUB_TOKEN') or os.environ.get('HF_TOKEN') or None
    control = _new_download_control(model_id)

    async def stream():
        """生成 SSE 事件序列；下载在线程池里跑，事件经队列回灌到事件循环。"""
        # 拿到当前事件循环：下载线程靠它把进度安全地投递回协程。
        loop = asyncio.get_running_loop()

        def _fmt(data: dict) -> str:
            """把 dict 编码成一条 SSE data 事件。"""
            return f'data: {json.dumps(data)}\n\n'

        try:
            yield _fmt({'percent': 0, 'status': 'Listing repository files...'})
            _check_download_control(control)

            # 阻塞的网络调用放到线程池，避免卡住事件循环。
            files = await loop.run_in_executor(
                None,
                lambda: [
                    f for f in _list_repo_files(repo_id, hf_token)
                    # 有 include 列表时只保留命中前缀的文件。
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
                base_pct = 1 + round(i / total * DOWNLOAD_PCT_SPAN)
                yield _fmt({
                    'percent': base_pct,
                    'file': filename,
                    'fileIndex': i + 1,
                    'totalFiles': total,
                    'status': f'Starting {filename}',
                    'bytesDownloaded': 0,
                    'stalledSeconds': 0,
                })

                # 每个文件一个队列：把工作线程的进度回调桥接到本协程。
                queue: asyncio.Queue[dict] = asyncio.Queue()

                def _progress(msg: dict) -> None:
                    # 工作线程里不能直接 await，必须走线程安全的调度入口。
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

                # 边下边刷：只要下载还没结束就持续把队列里的进度吐成 SSE。
                while not dl_future.done():
                    try:
                        msg = await asyncio.wait_for(queue.get(), timeout=2.0)
                    except asyncio.TimeoutError:
                        # 2s 内没有新进度（例如大文件分块慢）：继续等，不结束流。
                        continue
                    else:
                        yield _fmt(msg)

                final_size = await dl_future
                _check_download_control(control)

                pct = 1 + round((i + 1) / total * DOWNLOAD_PCT_SPAN)
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
            # 只删半成品（.part）文件；已完成的文件保留，
            # 下次下载可从中断处续传。
            for part in dest_dir.rglob('*.part'):
                part.unlink(missing_ok=True)
            yield _fmt({'cancelled': True, 'status': 'cancelled'})
        except Exception as exc:  # noqa: BLE001 - SSE streams surface errors as events
            # SSE 已开流后无法再改 HTTP 状态码，只能把错误作为事件发出去。
            yield _fmt({'error': str(exc)})
        finally:
            # 仅当控制项仍属于本次会话时才移除。
            # 同一 model_id 可能已被新会话接管控制项，故先比对身份再删。
            if _download_controls.get(model_id) is control:
                _download_controls.pop(model_id, None)

    return StreamingResponse(stream(), media_type='text/event-stream')
