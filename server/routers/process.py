"""Mesh processing endpoint for extension nodes (mesh → mesh tools).

Accepts a mesh file URL already on disk (/files/...), runs the requested tool
in a worker thread, and reports progress through the shared job registry so
the frontend can poll /generate/jobs/{id}.
"""

import asyncio
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import WORKSPACE_DIR
from generators.base import GenerationCancelled
from jobs import JobState, jobs
from tools import mesh_tools

router = APIRouter(tags=['process'])

_background_tasks: set[asyncio.Task] = set()


def _within_workspace(path: Path) -> bool:
    """判断路径（须已 resolve）是否位于 workspace 之内。

    用 `relative_to` 归属判断而非字符串前缀：`workspace-escape` 兄弟目录
    能骗过 startswith（优化文档 12.2 的最小复现），骗不过 relative_to。
    """
    try:
        path.relative_to(WORKSPACE_DIR.resolve())
        return True
    except ValueError:
        return False


def _within_import_temp(path: Path) -> bool:
    """serve-file 分支的边界：仅放行 meshforge_import_* 临时转换目录内的文件。"""
    import tempfile

    tmp_root = Path(tempfile.gettempdir()).resolve()
    try:
        path.relative_to(tmp_root)
    except ValueError:
        return False
    return any(p.name.startswith('meshforge_import_') for p in path.parents)


class ProcessRequest(BaseModel):
    mesh_url: str
    extension_id: str
    params: dict = {}


def _resolve_local(mesh_url: str) -> Path:
    """Map a mesh URL back to a file on disk.

    Accepts:
    - workspace URLs (/files/... or http://host/files/...) — must stay inside
      WORKSPACE_DIR (the /process/mesh security boundary).
    - serve-file URLs (/optimize/serve-file?path=<abs> or the absolute http
      form) — produced by the native-dialog Import→Mesh flow (Load 3D Mesh
      nodes and the Generate-page toolbar). The ?path= query must point at a
      workspace file or a meshforge_import_* temp conversion output — the
      same boundary /optimize/serve-file itself enforces.
    - bare absolute/relative paths (legacy).
    """
    path_part = mesh_url
    query = ''
    if mesh_url.startswith(('http://', 'https://')):
        parsed = urlparse(mesh_url)
        path_part, query = parsed.path, parsed.query
    elif mesh_url.startswith('/optimize/serve-file') and '?' in mesh_url:
        parsed = urlparse(mesh_url)
        path_part, query = parsed.path, parsed.query
    elif not mesh_url.startswith('/files/'):
        # 裸路径（例如带盘符的 Windows 绝对路径）——按原样使用；
        # 切勿 urlparse，否则盘符会被当成协议。
        path_part = mesh_url

    if path_part.startswith('/optimize/serve-file') and query:
        qs = parse_qs(query)
        picked = (qs.get('path') or [''])[0]
        if not picked:
            raise HTTPException(status_code=400, detail='serve-file url missing ?path=')
        path = Path(picked).resolve()
        if path.suffix.lower() != '.glb':
            raise HTTPException(status_code=400, detail='only GLB files can be processed')
        if not path.is_file():
            raise HTTPException(status_code=404, detail=f'mesh file not found: {mesh_url}')
        # 与 serve-file 相同的边界：workspace 内或临时转换目录内。
        if not (_within_workspace(path) or _within_import_temp(path)):
            raise HTTPException(status_code=403, detail='mesh_url outside workspace')
        return path

    if path_part.startswith('/files/'):
        path = (WORKSPACE_DIR / path_part[len('/files/'):]).resolve()
    else:
        path = Path(path_part).resolve()
    if not _within_workspace(path):
        raise HTTPException(status_code=400, detail='mesh_url outside workspace')
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f'mesh file not found: {mesh_url}')
    return path


@router.post('/process/mesh')
async def process_mesh(req: ProcessRequest) -> dict:
    tool = mesh_tools.TOOLS.get(req.extension_id)
    if tool is None:
        raise HTTPException(status_code=400, detail=f"unknown tool '{req.extension_id}'")
    mesh_path = _resolve_local(req.mesh_url)

    job = jobs.create(req.extension_id)
    out_dir = WORKSPACE_DIR / job.job_id

    async def run() -> None:
        cancel = jobs._cancel_flag(job.job_id)

        def report(progress: float, message: str = '') -> None:
            if cancel.is_set():
                raise GenerationCancelled
            job.progress = max(0.0, min(1.0, progress))
            if message:
                job.message = message

        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            result = await asyncio.to_thread(
                tool, mesh_path, out_dir, req.params, report, cancel
            )
            if cancel.is_set():
                jobs.mark_finished(job, JobState.CANCELLED)
            else:
                job.progress = 1.0
                job.result_url = f'/files/{job.job_id}/{result.name}'
                jobs.mark_finished(job, JobState.SUCCEEDED)
        except GenerationCancelled:
            jobs.mark_finished(job, JobState.CANCELLED)
        except Exception as exc:  # noqa: BLE001 - 捕获后写入 job.error 暴露给 UI
            jobs.mark_finished(job, JobState.FAILED, f'{type(exc).__name__}: {exc}')

    task = asyncio.create_task(run())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    return {'job_id': job.job_id}
