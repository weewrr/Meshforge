import asyncio
import json
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, UploadFile

from generators.registry import registry
from jobs import JobState, jobs

router = APIRouter(tags=['generate'])

WORKSPACE_DIR = Path(__file__).resolve().parent.parent / 'workspace'
UPLOAD_DIR = WORKSPACE_DIR / 'uploads'

# Keep strong references so create_task'd coroutines are not garbage collected.
_background_tasks: set[asyncio.Task] = set()


@router.get('/generators')
def list_generators() -> list[dict]:
    return registry.describe_all()


@router.get('/files/list-dir')
def list_dir(dir: str = '', ext: str = '') -> dict:
    """List files under a workspace subdirectory (For Each iterator support)."""
    base = WORKSPACE_DIR.resolve()
    target = (base / dir).resolve() if dir else base
    if not str(target).startswith(str(base)):
        raise HTTPException(status_code=400, detail='dir outside workspace')
    if not target.is_dir():
        raise HTTPException(status_code=404, detail=f'dir not found: {dir}')
    exts = [e.strip().lower() for e in ext.split(',') if e.strip()]
    names = sorted(
        f.name for f in target.iterdir()
        if f.is_file() and (not exts or f.suffix.lower() in exts)
    )
    prefix = f'/files/{dir}/'.replace('//', '/') if dir else '/files/'
    return {'dir': dir, 'files': [f'{prefix}{n}' for n in names]}


@router.post('/generate/from-image')
async def generate_from_image(
    image: UploadFile,
    generator_id: str = Form('mock-relief'),
    params_json: str = Form('{}'),
) -> dict:
    try:
        params = json.loads(params_json) if params_json else {}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail='params_json is not valid JSON')

    if registry.get(generator_id) is None:
        raise HTTPException(status_code=400, detail=f"unknown generator '{generator_id}'")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    suffix = Path(image.filename or 'image.png').suffix or '.png'
    image_path = UPLOAD_DIR / f'{uuid.uuid4().hex}{suffix}'
    try:
        with image_path.open('wb') as fh:
            shutil.copyfileobj(image.file, fh)
    finally:
        await image.close()

    job = jobs.create(generator_id)
    out_dir = WORKSPACE_DIR / job.job_id

    task = asyncio.create_task(jobs.run(job, image_path, out_dir, params))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    return {'job_id': job.job_id}


@router.post('/upload')
async def upload_file(file: UploadFile) -> dict:
    """Generic asset upload for node-embedded files (images, meshes)."""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename or 'file').suffix
    if suffix and not suffix.isascii():
        suffix = ''
    name = f'{uuid.uuid4().hex}{suffix}'
    dest = UPLOAD_DIR / name
    try:
        with dest.open('wb') as fh:
            shutil.copyfileobj(file.file, fh)
    finally:
        await file.close()
    return {'url': f'/files/uploads/{name}', 'fileName': file.filename or name}


@router.get('/generate/jobs/{job_id}')
def job_status(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail='job not found')
    return {
        'job_id': job.job_id,
        'state': job.state.value,
        'progress': job.progress,
        'message': job.message,
        'result_url': job.result_url,
        'error': job.error,
    }


@router.post('/generate/jobs/{job_id}/cancel')
def cancel_job(job_id: str) -> dict:
    if jobs.get(job_id) is None:
        raise HTTPException(status_code=404, detail='job not found')
    jobs.request_cancel(job_id)
    return {'ok': True}
