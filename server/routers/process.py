"""Mesh processing endpoint for extension nodes (mesh → mesh tools).

Accepts a mesh file URL already on disk (/files/...), runs the requested tool
in a worker thread, and reports progress through the shared job registry so
the frontend can poll /generate/jobs/{id}.
"""

import asyncio
import uuid
from pathlib import Path
from urllib.parse import urlparse

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

    Accepts both relative workspace URLs (/files/...) and absolute URLs
    (http://host/files/...) — the frontend passes fullUrl() output (absolute)
    when opening assets from the library or after workflow runs.
    """
    if mesh_url.startswith(('http://', 'https://')):
        mesh_url = urlparse(mesh_url).path
    if mesh_url.startswith('/files/'):
        rel = mesh_url[len('/files/'):]
        path = WORKSPACE_DIR / rel
    else:
        path = Path(mesh_url)
    path = path.resolve()
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
