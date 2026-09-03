import asyncio
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

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


# ─── Import an image by absolute path (Modly-aligned) ────────────────────────
# Same rationale as /optimize/import-by-path: the native dialog runs in the
# Electron main process and only returns a filesystem path, so no Chromium
# <input type=file> is ever opened in the renderer (documented to freeze this
# machine's renderer). The file is copied into workspace/uploads — identical to
# what /upload produces — so every existing consumer (imageNode url → fetch,
# Generate-page preview, agent attachments) works unchanged.

ALLOWED_IMAGE_EXTS = {'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'}


class UploadFromPathRequest(BaseModel):
    path: str


@router.post('/upload/from-path')
async def import_image_by_path(body: UploadFromPathRequest) -> dict:
    file_path = Path(body.path)
    if not file_path.is_file():
        raise HTTPException(status_code=400, detail='file not found')
    ext = file_path.suffix.lstrip('.').lower()
    if ext not in ALLOWED_IMAGE_EXTS:
        raise HTTPException(status_code=400, detail=f'unsupported image format: {ext}')

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    name = f'{uuid.uuid4().hex}.{ext}'
    dest = UPLOAD_DIR / name
    try:
        shutil.copyfile(file_path, dest)
    except OSError as err:
        raise HTTPException(status_code=400, detail=f'unreadable file: {err}')
    return {'url': f'/files/uploads/{name}', 'fileName': file_path.name}


# ─── Import mesh by absolute path (Modly-aligned) ────────────────────────────
# The Electron main process opens a native file dialog and returns a filesystem
# path — no bytes ever flow through the renderer, and no Chromium <input
# type=file> is involved (which is documented to freeze this machine's
# renderer). .glb is served in place; obj/stl/ply are converted to GLB with
# trimesh in a temp dir. Served URLs go through /optimize/serve-file so the
# viewer always receives a proper model/gltf-binary response.

ALLOWED_IMPORT_EXTS = {'glb', 'obj', 'stl', 'ply'}


class ImportByPathRequest(BaseModel):
    path: str


@router.post('/optimize/import-by-path')
async def import_mesh_by_path(body: ImportByPathRequest) -> dict:
    file_path = Path(body.path)
    if not file_path.is_file():
        raise HTTPException(status_code=400, detail='file not found')
    ext = file_path.suffix.lstrip('.').lower()
    if ext not in ALLOWED_IMPORT_EXTS:
        raise HTTPException(status_code=400, detail=f'unsupported format: {ext}')

    if ext == 'glb':
        # Serve the original file directly — no copy.
        return {'url': f'/optimize/serve-file?path={quote(str(file_path))}'}

    # obj / stl / ply: convert to GLB in a temp directory.
    tmp_dir = tempfile.mkdtemp(prefix='meshforge_import_')
    output_path = os.path.join(tmp_dir, 'mesh.glb')
    try:
        import trimesh  # lazy: only needed for non-GLB conversions
        loaded = trimesh.load(str(file_path))
        loaded.export(output_path)
    except Exception as err:  # noqa: BLE001 — surface a clean error, never 500-crash
        raise HTTPException(status_code=400, detail=f'unrecognised mesh: {err}')
    return {'url': f'/optimize/serve-file?path={quote(output_path)}'}


@router.get('/optimize/serve-file')
def serve_imported_file(path: str) -> FileResponse:
    file_path = Path(path)
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail='file not found')
    if file_path.suffix.lower() != '.glb':
        raise HTTPException(status_code=400, detail='only GLB files can be served')
    return FileResponse(str(file_path), media_type='model/gltf-binary')
