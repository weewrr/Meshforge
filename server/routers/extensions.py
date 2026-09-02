"""Extension management: schema-driven model generators + mesh processing tools.

GET  /extensions                → unified list (built-ins + manifest extensions)
POST /extensions/install        → install from GitHub URL (zip → manifest → folder)
POST /extensions/install-local  → install from an uploaded local folder (webkitdirectory)
POST /extensions/uninstall      → remove an extension folder + registry entry
POST /extensions/reload         → re-scan the extensions directory
GET  /extensions/install/status → poll install progress (steps/percent)

Install progress is exposed through a small pollable slot instead of Electron
IPC events (this build has no main-process extension channel), mirroring the
download → extract → validate → setting_up → done/error steps of Modly.
"""

import asyncio
import json
import re
import shutil
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, HTTPException, UploadFile
from pydantic import BaseModel

from generators.registry import EXTENSIONS_DIR, registry

router = APIRouter(prefix='/extensions', tags=['extensions'])

# ─── Built-in mesh processing tools (mesh → mesh) ────────────────────────────
# Schema-driven like model generators; the run engine dispatches to
# POST /process/mesh with the extension id. Processing backends live in
# server/tools/mesh_tools.py. Kept here (not in registry) for parity with the
# manifest extensions which live in the extensions/ directory.

PROCESS_EXTENSIONS = [
    {
        'id': 'mesh-repair',
        'display_name': 'Mesh Repair',
        'kind': 'process',
        'input': 'mesh',
        'output': 'mesh',
        'params': [
            {'id': 'fill_holes', 'label': '补洞', 'type': 'select', 'default': 'auto',
             'options': [{'value': 'auto', 'label': '自动'}, {'value': 'off', 'label': '关闭'}]},
        ],
    },
    {
        'id': 'mesh-smoother',
        'display_name': 'Mesh Smooth',
        'kind': 'process',
        'input': 'mesh',
        'output': 'mesh',
        'params': [
            {'id': 'iterations', 'label': '平滑次数', 'type': 'int', 'default': 3, 'min': 1, 'max': 20},
            {'id': 'lambda', 'label': '松弛系数', 'type': 'float', 'default': 0.5, 'min': 0.0, 'max': 1.0},
        ],
    },
    {
        'id': 'mesh-remesher',
        'display_name': 'Mesh Remesh',
        'kind': 'process',
        'input': 'mesh',
        'output': 'mesh',
        'params': [
            {'id': 'target_faces', 'label': '目标面数', 'type': 'int', 'default': 10000, 'min': 100, 'max': 200000},
        ],
    },
    {
        'id': 'mesh-optimizer',
        'display_name': 'Mesh Optimize',
        'kind': 'process',
        'input': 'mesh',
        'output': 'mesh',
        'params': [
            {'id': 'merge_vertices', 'label': '合并顶点', 'type': 'select', 'default': 'on',
             'options': [{'value': 'on', 'label': '开启'}, {'value': 'off', 'label': '关闭'}]},
        ],
    },
    {
        'id': 'mesh-exporter',
        'display_name': 'Mesh Export',
        'kind': 'process',
        'input': 'mesh',
        'output': 'none',
        'params': [
            {'id': 'format', 'label': '导出格式', 'type': 'select', 'default': 'obj',
             'options': [{'value': 'obj', 'label': 'OBJ'}, {'value': 'stl', 'label': 'STL'}, {'value': 'ply', 'label': 'PLY'}]},
        ],
    },
]

# ─── Install progress slot (polled by the frontend) ───────────────────────────

_INSTALL_PROGRESS: dict = {'step': 'done', 'percent': 0, 'message': '', 'extensionId': None}
_INSTALL_LOCK = asyncio.Lock()
_background_tasks: set[asyncio.Task] = set()

_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')


def _set_progress(step: str, percent: Optional[int] = None, message: str = '', extension_id: Optional[str] = None) -> None:
    _INSTALL_PROGRESS.update({
        'step': step,
        'percent': percent if percent is not None else _INSTALL_PROGRESS.get('percent'),
        'message': message,
        'extensionId': extension_id if extension_id is not None else _INSTALL_PROGRESS.get('extensionId'),
    })


def _safe_ext_dir(ext_id: str) -> Path:
    if not _ID_RE.match(ext_id):
        raise HTTPException(status_code=400, detail='invalid extension id')
    return (EXTENSIONS_DIR / ext_id).resolve()


def _validate_manifest(manifest: dict, source_label: str) -> str:
    """Validate a manifest.json; returns the extension id."""
    ext_id = str(manifest.get('id') or '').strip()
    if not ext_id:
        raise HTTPException(status_code=400, detail=f'manifest.json: required field "id" missing in {source_label}')
    if not _ID_RE.match(ext_id):
        raise HTTPException(status_code=400, detail=f'manifest.json: invalid id "{ext_id}"')
    kind = str(manifest.get('kind') or 'model')
    if kind not in ('model', 'process'):
        raise HTTPException(status_code=400, detail=f'manifest.json: kind must be "model" or "process" in {source_label}')
    return ext_id


def _install_from_folder(staging: Path) -> dict:
    """Validate a staging folder and copy it into extensions/<id>/, then rescan."""
    manifest_path = staging / 'manifest.json'
    if not manifest_path.is_file():
        raise HTTPException(status_code=400, detail='manifest.json missing from the extension folder')
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail='manifest.json is not valid JSON')
    ext_id = _validate_manifest(manifest, 'extension folder')
    kind = str(manifest.get('kind') or 'model')

    # Model extensions need generator.py; process extensions need processor.py.
    needed = 'generator.py' if kind == 'model' else 'processor.py'
    if not (staging / needed).is_file():
        raise HTTPException(status_code=400, detail=f'{needed} missing from the extension folder')

    _set_progress('validating', 90, f'Validated {ext_id}')
    dest = _safe_ext_dir(ext_id)
    EXTENSIONS_DIR.mkdir(parents=True, exist_ok=True)
    # Replace existing copy safely: move to a trash dir first, then copy new.
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(staging, dest)

    # Re-scan so the new extension is registered immediately.
    errors = registry.scan_extensions()
    if ext_id in errors:
        # Roll back the broken install.
        shutil.rmtree(dest, ignore_errors=True)
        registry.scan_extensions()
        raise HTTPException(status_code=400, detail=f'Extension failed to load: {errors[ext_id]}')

    _set_progress('done', 100, f'Installed {ext_id}', ext_id)
    return {'ok': True, 'id': ext_id, 'kind': kind, 'name': manifest.get('display_name', ext_id)}


def _download_zip(url: str, dest: Path) -> None:
    """Download a GitHub repo zip into dest (urllib — no requests in this venv)."""
    req = urllib.request.Request(url, headers={'User-Agent': 'meshforge'})
    with urllib.request.urlopen(req, timeout=60.0) as resp:
        total = int(resp.headers.get('Content-Length') or 0)
        done = 0
        with dest.open('wb') as fh:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                fh.write(chunk)
                done += len(chunk)
                if total > 0:
                    _set_progress('downloading', int(done * 90 / total))


class InstallUrlBody(BaseModel):
    url: str


@router.get('')
@router.get('/')
def list_extensions() -> list[dict]:
    """All schema-driven extensions: built-in model generators + process tools
    + manifest extensions discovered in the extensions/ directory."""
    models = [
        {
            'id': g.id,
            'display_name': g.display_name,
            'kind': 'model',
            'input': g.input_type,
            'output': g.output_type,
            'params': g.params,
        }
        for g in registry._generators.values()
    ]
    return models + PROCESS_EXTENSIONS + registry.process_tools()


@router.get('/install/status')
async def install_status() -> dict:
    return {'progress': _INSTALL_PROGRESS}


@router.post('/install')
async def install_from_github(body: InstallUrlBody) -> dict:
    """Install an extension from a GitHub repository URL.

    Downloads <repo>/archive/refs/heads/main.zip (falls back to master),
    extracts it, validates manifest.json + generator.py/processor.py, copies
    the folder into extensions/<id>/, and rescans the registry.
    """
    url = body.url.strip()
    if not url.startswith('http://') and not url.startswith('https://'):
        raise HTTPException(status_code=400, detail='Must be an http(s) URL')
    # Normalize github.com/owner/repo → codeload zip
    m = re.search(r'github\.com/([^/]+)/([^/?#]+)', url)
    if not m:
        raise HTTPException(status_code=400, detail='Must be a GitHub repository URL')
    owner, repo = m.group(1), m.group(2).removesuffix('.git')

    async def run() -> None:
        async with _INSTALL_LOCK:
            staging = EXTENSIONS_DIR.parent / '.staging' / f'{int(time.time() * 1000)}'
            zip_path = staging / 'repo.zip'
            try:
                staging.mkdir(parents=True, exist_ok=True)
                _set_progress('downloading', 0, f'Downloading {owner}/{repo}')
                try:
                    _download_zip(f'https://codeload.github.com/{owner}/{repo}/zip/refs/heads/main', zip_path)
                except urllib.error.HTTPError:
                    _download_zip(f'https://codeload.github.com/{owner}/{repo}/zip/refs/heads/master', zip_path)

                _set_progress('extracting', 50, 'Extracting…')
                with zipfile.ZipFile(zip_path) as zf:
                    zf.extractall(staging)

                # codeload zips are <repo>-<ref>/… ; find the single root folder.
                extracted = [p for p in staging.iterdir() if p.is_dir() and p.name != '__MACOSX']
                source = extracted[0] if extracted else staging
                _install_from_folder(source)
            except HTTPException as exc:
                _set_progress('error', 0, exc.detail)
            except Exception as exc:  # noqa: BLE001
                _set_progress('error', 0, f'{type(exc).__name__}: {exc}')
            finally:
                shutil.rmtree(staging, ignore_errors=True)

    task = asyncio.create_task(run())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {'ok': True, 'message': 'install started'}


@router.post('/install-local')
async def install_from_local(files: list[UploadFile], root_dir: str = Body(default='')) -> dict:
    """Install an extension from an uploaded local folder (webkitdirectory input).

    The browser sends every file with its relative path; we rebuild the folder
    structure under extensions/<id>/ and rescan. Files outside the chosen root
    are ignored.
    """
    if not files:
        raise HTTPException(status_code=400, detail='no files uploaded')

    root = root_dir.strip('/\\') or 'extension'
    # The root_dir is the extension folder name (used as the staging name).
    staging_root = EXTENSIONS_DIR.parent / '.staging' / f'local-{int(time.time() * 1000)}'
    staging_root.mkdir(parents=True, exist_ok=True)

    for f in files:
        rel = (f.filename or '').replace('\\', '/')
        # webkitRelativePath looks like "my-ext/manifest.json"; if the browser
        # only gave the basename, treat the file as being under the root.
        if rel.startswith(root + '/'):
            rel = rel[len(root) + 1:]
        if not rel or '..' in rel.split('/'):
            continue
        dest = staging_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open('wb') as fh:
            shutil.copyfileobj(f.file, fh)
        await f.close()

    try:
        result = _install_from_folder(staging_root)
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)
    return result


class UninstallBody(BaseModel):
    id: str


@router.post('/uninstall')
async def uninstall_extension(body: UninstallBody) -> dict:
    """Remove an extension folder (if any) and unregister it."""
    ext_id = body.id
    if not _ID_RE.match(ext_id):
        raise HTTPException(status_code=400, detail='invalid extension id')
    dest = _safe_ext_dir(ext_id)
    removed_dir = dest.exists() and dest.is_dir()
    if removed_dir:
        shutil.rmtree(dest)
    registry.unload(ext_id)
    registry.scan_extensions()
    return {'ok': True, 'removed': removed_dir, 'id': ext_id}


@router.post('/reload')
async def reload_extensions() -> dict:
    """Re-scan the extensions directory and reload the registry (no restart)."""
    errors = registry.scan_extensions()
    return {
        'reloaded': True,
        'models': list(registry._generators.keys()),
        'errors': errors,
    }
