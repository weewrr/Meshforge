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
import urllib.parse
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


def _download_to(url: str, dest: Path) -> None:
    """Stream a file to dest (stdlib urllib — no requests in this venv)."""
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


def _http_get_json(url: str) -> dict:
    """GET a JSON endpoint, raising a descriptive HTTPException on failure."""
    req = urllib.request.Request(url, headers={'User-Agent': 'meshforge'})
    try:
        with urllib.request.urlopen(req, timeout=60.0) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f'lookup failed ({exc.code}) for {url}')
    except (urllib.error.URLError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f'lookup failed ({type(exc).__name__}) for {url}')


def _parse_hf(url: str) -> str:
    """Extract 'owner/repo' from a HuggingFace URL (huggingface.co or hf.co)."""
    m = re.search(r'(?:huggingface|hf)\.co/(?:models/)?([^/]+)/([^/?#]+)', url)
    if not m:
        raise HTTPException(status_code=400, detail='Must be a HuggingFace repository URL')
    return f"{m.group(1)}/{m.group(2).removesuffix('.git')}"


def _hf_file_list(repo: str) -> list[str]:
    """List file paths in a HuggingFace repo via the tree API."""
    data = _http_get_json(f'https://huggingface.co/api/models/{repo}/tree/main?recursive=true')
    files = []
    for item in data:
        if isinstance(item, dict) and item.get('type') == 'file':
            files.append(item['path'])
    return files


def _parse_ms(url: str) -> tuple[str, str]:
    """Extract (owner, repo) from a ModelScope URL."""
    m = re.search(r'modelscope\.cn/(?:models/)?([^/]+)/([^/?#]+)', url)
    if not m:
        raise HTTPException(status_code=400, detail='Must be a ModelScope repository URL')
    return m.group(1), m.group(2).removesuffix('.git')


def _ms_file_list(owner: str, repo: str) -> list[str]:
    """List file paths in a ModelScope repo via the repo files API."""
    data = _http_get_json(f'https://modelscope.cn/api/v1/models/{owner}/{repo}/repo/files?Revision=master')
    files = []
    for item in data.get('Data', {}).get('Files', []) or []:
        if isinstance(item, dict) and item.get('Type') == 'blob':
            files.append(item['Path'])
    return files


def _download_repo_files(paths: list[str], download_url: str, staging: Path) -> None:
    """Download a list of relative file paths into staging (dirs / __MACOSX skipped)."""
    for rel in paths:
        if rel.startswith('__MACOSX') or rel.endswith('/'):
            continue
        dest = (staging / rel.lstrip('/')).resolve()
        # Never let a path escape the staging folder.
        if not str(dest).startswith(str(staging.resolve())):
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        _download_to(download_url.format(urllib.parse.quote_plus(rel)), dest)


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
    # Manifest-loaded extensions carry optional HF download metadata so the
    # Models page can offer a weight download for them.
    for ext in models + registry.process_tools():
        manifest = registry.get_manifest(ext['id'])
        if not manifest:
            continue
        for key in ('hfRepo', 'hf_skip_prefixes', 'hf_include_prefixes'):
            if manifest.get(key) is not None:
                ext[key] = manifest[key]
    return models + PROCESS_EXTENSIONS + registry.process_tools()


@router.get('/install/status')
async def install_status() -> dict:
    return {'progress': _INSTALL_PROGRESS}


@router.post('/install')
async def install_extension(body: InstallUrlBody) -> dict:
    """Install an extension from a GitHub / HuggingFace / ModelScope repository URL.

    The download phase is dispatched by the URL host, but every source lands in
    a staging folder that is validated + copied by the same `_install_from_folder`.
    """
    url = body.url.strip()
    if not url.startswith('http://') and not url.startswith('https://'):
        raise HTTPException(status_code=400, detail='Must be an http(s) URL')

    # Classify the source (150ms of work, fine outside the async task).
    low = url.lower()
    if 'github.com' in low:
        source = 'github'
        m = re.search(r'github\.com/([^/]+)/([^/?#]+)', url)
        if not m:
            raise HTTPException(status_code=400, detail='Must be a GitHub repository URL')
        owner_repo = f"{m.group(1)}/{m.group(2).removesuffix('.git')}"
    elif 'huggingface.co' in low or 'hf.co' in low:
        source = 'huggingface'
        owner_repo = _parse_hf(url)
    elif 'modelscope.cn' in low:
        source = 'modelscope'
        owner_repo = '/'.join(_parse_ms(url))
    else:
        raise HTTPException(status_code=400, detail='Must be a GitHub, HuggingFace or ModelScope repository URL')

    async def run() -> None:
        async with _INSTALL_LOCK:
            staging = EXTENSIONS_DIR.parent / '.staging' / f'{int(time.time() * 1000)}'
            try:
                staging.mkdir(parents=True, exist_ok=True)
                _set_progress('downloading', 0, f'Downloading {owner_repo}')

                if source == 'github':
                    zip_path = staging / 'repo.zip'
                    owner, repo = owner_repo.split('/', 1)
                    try:
                        _download_to(f'https://codeload.github.com/{owner}/{repo}/zip/refs/heads/main', zip_path)
                    except urllib.error.HTTPError:
                        _download_to(f'https://codeload.github.com/{owner}/{repo}/zip/refs/heads/master', zip_path)
                    _set_progress('extracting', 50, 'Extracting…')
                    with zipfile.ZipFile(zip_path) as zf:
                        zf.extractall(staging)
                    # codeload zips are <repo>-<ref>/… ; find the single root folder.
                    extracted = [p for p in staging.iterdir() if p.is_dir() and p.name != '__MACOSX']
                    source_folder = extracted[0] if extracted else staging
                elif source == 'huggingface':
                    paths = _hf_file_list(owner_repo)
                    _download_repo_files(
                        paths,
                        f'https://huggingface.co/{owner_repo}/resolve/main/' + '{}',
                        staging,
                    )
                    source_folder = staging
                else:  # modelscope
                    owner, repo = owner_repo.split('/', 1)
                    paths = _ms_file_list(owner, repo)
                    _download_repo_files(
                        paths,
                        f'https://modelscope.cn/api/v1/models/{owner}/{repo}/repo?Revision=master&FilePath=' + '{}',
                        staging,
                    )
                    source_folder = staging

                _set_progress('validating', 90, 'Validating…')
                _install_from_folder(source_folder)
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


class InstallDirBody(BaseModel):
    path: str


@router.post('/install-dir')
def install_from_dir(body: InstallDirBody) -> dict:
    """Install an extension straight from a local folder path.

    The folder comes from the main-process native directory dialog
    (fs:selectFolder): a renderer webkitdirectory <input type=file> freezes /
    crashes this machine's Chromium (mesh/image pickers had the same root
    cause — 19e/19f/19h), so the renderer never touches the files. The backend
    copies the tree server-side, then reuses the exact same validation +
    install path as /install-local: manifest.json + generator.py/processor.py,
    copy to extensions/<id>/, rescan, roll back on load failure.
    """
    src = Path(body.path).expanduser()
    if not src.is_dir():
        raise HTTPException(status_code=400, detail=f'folder not found: {src}')
    src_res = src.resolve()
    ext_res = EXTENSIONS_DIR.resolve()
    # Refuse picking a meshforge-internal folder (extensions dir itself, an
    # already-installed extension, or the staging area) — those would either
    # self-copy recursively or trash an installed extension.
    if src_res == ext_res or ext_res in src_res.parents or '.staging' in src_res.parts:
        raise HTTPException(status_code=400, detail='pick the extension source folder (the one containing manifest.json), not a meshforge-internal directory')

    # Sanity caps so an accidentally picked giant folder can't flood the disk.
    total_bytes = 0
    total_files = 0
    try:
        for p in src_res.rglob('*'):
            if p.is_file():
                try:
                    total_bytes += p.stat().st_size
                except OSError:
                    continue
                total_files += 1
                if total_bytes > 64 * 1024 * 1024 or total_files > 2000:
                    raise HTTPException(status_code=400, detail='folder too large (limit 64 MB / 2000 files)')
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(status_code=400, detail=f'cannot read folder: {src}')

    staging_root = EXTENSIONS_DIR.parent / '.staging' / f'local-{int(time.time() * 1000)}'
    staging_root.parent.mkdir(parents=True, exist_ok=True)
    try:
        # symlinks=True: copy links as-is instead of following (avoids cycles).
        shutil.copytree(src_res, staging_root, symlinks=True)
        return _install_from_folder(staging_root)
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


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
