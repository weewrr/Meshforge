"""Mesh processing endpoint for extension nodes (mesh → mesh tools).

Accepts a mesh file URL already on disk (/files/...), runs the requested tool
in a worker thread, and reports progress through the shared job registry so
the frontend can poll /generate/jobs/{id}.
"""

import asyncio
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from generators.base import GenerationCancelled
from jobs import JobState, jobs
from tools import mesh_tools

router = APIRouter(tags=['process'])

WORKSPACE_DIR = Path(__file__).resolve().parent.parent / 'workspace'

_background_tasks: set[asyncio.Task] = set()


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
      nodes and the Generate-page toolbar). The ?path= query is the absolute
      file path the user picked; /optimize/serve-file already validated that
      it exists and is .glb, so the workspace check is intentionally skipped
      for this branch.
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
        # Bare path (e.g. a Windows absolute path with a drive letter) — used
        # as-is; do NOT urlparse it or the drive letter becomes a scheme.
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
        return path

    if path_part.startswith('/files/'):
        path = (WORKSPACE_DIR / path_part[len('/files/'):]).resolve()
    else:
        path = Path(path_part).resolve()
    if not str(path).startswith(str(WORKSPACE_DIR.resolve())):
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
                job.state = JobState.CANCELLED
            else:
                job.progress = 1.0
                job.state = JobState.SUCCEEDED
                job.result_url = f'/files/{job.job_id}/{result.name}'
        except GenerationCancelled:
            job.state = JobState.CANCELLED
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI
            job.state = JobState.FAILED
            job.error = f'{type(exc).__name__}: {exc}'

    task = asyncio.create_task(run())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    return {'job_id': job.job_id}
