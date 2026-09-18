"""
图片生成与导入相关的 API 路由。

提供：列出已注册生成器、从图片提交后台生成任务、通用/路径上传、查询与取消
任务状态，以及通过绝对路径导入图片/网格（绕开渲染进程的 `<input type=file>`，
避免冻结本机 Chromium）。产物统一落到 workspace，再由 `/files` 提供访问。
"""

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

from config import WORKSPACE_DIR
from generators.registry import registry
from jobstore import store as _jobstore
from jobs import jobs
from schemas import JobStatusOut

router = APIRouter(tags=['generate'])

UPLOAD_DIR = WORKSPACE_DIR / 'uploads'

# 单个上传文件的大小上限（含 /upload、/generate/from-image 的图片输入）。
# 贴图与四视图输入远小于此值；上限只为拦截无限制 copyfileobj 撑爆磁盘。
MAX_UPLOAD_BYTES = 200 * 1024 * 1024

# 保活强引用，避免 create_task 创建的协程被垃圾回收提前取消。
_background_tasks: set[asyncio.Task] = set()


def _within_workspace(path: Path) -> bool:
    """判断路径（须已 resolve）是否位于 workspace 之内。

    用 `is_relative_to` 而不是字符串前缀比较：`workspace-escape` 这类
    兄弟目录能骗过 startswith，却骗不过真正的路径归属判断（文档 12.2）。
    """
    try:
        path.relative_to(WORKSPACE_DIR.resolve())
        return True
    except ValueError:
        return False


def _within_import_temp(path: Path) -> bool:
    """判断路径是否位于本应用创建的 meshforge_import_* 临时转换目录内。

    serve-file 对这类目录放行：obj/stl/ply 导入转换产生的 GLB 只存在于这里，
    且目录名带随机后缀、位于 OS 临时目录，攻击者无法借此读任意盘上文件。
    """
    tmp_root = Path(tempfile.gettempdir()).resolve()
    try:
        path.relative_to(tmp_root)
    except ValueError:
        return False
    return any(p.name.startswith('meshforge_import_') for p in path.parents)


def _save_capped(upload: UploadFile, dest: Path) -> None:
    """把上传文件落盘，超出 MAX_UPLOAD_BYTES 立即中止并删除半成品。"""
    try:
        written = 0
        with dest.open('wb') as fh:
            while True:
                chunk = upload.file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail=f'file too large (limit {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)')
                fh.write(chunk)
    finally:
        upload.file.close()


@router.get('/generators')
def list_generators() -> list[dict]:
    return registry.describe_all()


@router.get('/files/list-dir')
def list_dir(dir: str = '', ext: str = '') -> dict:
    """List files under a workspace subdirectory (For Each iterator support)."""
    base = WORKSPACE_DIR.resolve()
    target = (base / dir).resolve() if dir else base
    # is_relative_to 语义的归属校验：拒绝 workspace 外与兄弟目录前缀误判。
    if not _within_workspace(target):
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
    generator_id: str = Form('hunyuan3d-2-mini'),
    params_json: str = Form('{}'),
    # 可选四向视图输入（hunyuan3d-2-mv）。存在时先落盘，
    # 再以 params['view_front'] … = 本地路径 的形式交给生成器。
    front: UploadFile | None = None,
    left: UploadFile | None = None,
    back: UploadFile | None = None,
    right: UploadFile | None = None,
) -> dict:
    """POST /generate/from-image：提交一次图片转 3D 生成任务。

    接收主图片与可选的四视图输入，创建后台任务并返回 `job_id`，
    前端据此轮询 `/generate/jobs/{job_id}` 获取进度。
    """
    try:
        params = json.loads(params_json) if params_json else {}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail='params_json is not valid JSON')

    if registry.get(generator_id) is None:
        raise HTTPException(status_code=400, detail=f"unknown generator '{generator_id}'")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    def _save(upload: UploadFile | None, suffix: str) -> str | None:
        if upload is None:
            return None
        ext = Path(upload.filename or f'{suffix}.png').suffix or '.png'
        dest = UPLOAD_DIR / f'{uuid.uuid4().hex}{ext}'
        _save_capped(upload, dest)
        return str(dest)

    # 主图（必填）+ 可选四视图，逐个落盘后写入 params。
    main_path = _save(image, 'image')
    for tag, upload in (('front', front), ('left', left), ('back', back), ('right', right)):
        p = _save(upload, tag)
        if p is not None:
            params[f'view_{tag}'] = p

    job = jobs.create(generator_id)
    out_dir = WORKSPACE_DIR / job.job_id

    task = asyncio.create_task(jobs.run(job, Path(main_path), out_dir, params))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    return {'job_id': job.job_id}


@router.post('/upload')
async def upload_file(file: UploadFile) -> dict:
    """通用资源上传，供节点内嵌文件（图片、网格）使用。"""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename or 'file').suffix
    if suffix and not suffix.isascii():
        suffix = ''
    name = f'{uuid.uuid4().hex}{suffix}'
    dest = UPLOAD_DIR / name
    _save_capped(file, dest)
    return {'url': f'/files/uploads/{name}', 'fileName': file.filename or name}


@router.get('/generate/jobs/{job_id}', response_model=JobStatusOut)
def job_status(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is not None:
        return {
            'job_id': job.job_id,
            'state': job.state.value,
            'progress': job.progress,
            'message': job.message,
            'result_url': job.result_url,
            'error': job.error,
        }
    # 内存未命中（TTL 清理或后端重启后）：回退查询 SQLite 历史终态（文档 4.1）。
    hist = _jobstore.get(job_id)
    if hist is not None:
        return {
            'job_id': hist['job_id'],
            'state': hist['state'],
            'progress': hist['progress'],
            'message': hist['message'],
            'result_url': hist['result_url'],
            'error': hist['error'],
            'historical': True,
        }
    raise HTTPException(status_code=404, detail='job not found')


@router.post('/generate/jobs/{job_id}/cancel')
def cancel_job(job_id: str) -> dict:
    """POST /generate/jobs/{job_id}/cancel：请求协作式取消一个生成任务。"""
    if jobs.get(job_id) is None:
        raise HTTPException(status_code=404, detail='job not found')
    jobs.request_cancel(job_id)
    return {'ok': True}


# ─── 通过绝对路径导入图片（对齐 Modly）────────────────────────────────────
# 与 /optimize/import-by-path 同理：原生文件对话框运行在 Electron 主进程，
# 只回传文件系统路径，因此渲染进程从不打开 Chromium 的 <input type=file>
# （已知会冻结本机渲染进程）。文件被复制到 workspace/uploads，
# 与 /upload 的产物一致，故所有既有消费方（imageNode url → fetch、
# Generate 页预览、agent 附件）都无需改动。

ALLOWED_IMAGE_EXTS = {'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'}


class UploadFromPathRequest(BaseModel):
    path: str


@router.post('/upload/from-path')
async def import_image_by_path(body: UploadFromPathRequest) -> dict:
    """POST /upload/from-path：按绝对路径把磁盘图片导入 workspace/uploads。

    绕开渲染进程的文件选择，复制后的 URL 与普通上传完全一致。
    """
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
# 由 Electron 主进程打开原生文件对话框并返回文件系统路径——
# 字节流完全不经过渲染进程，也不使用 Chromium 的 <input type=file>
# （已有记录表明它会冻住这台机器的渲染进程）。.glb 原样直接提供；
# obj/stl/ply 则用 trimesh 在临时目录里转换成 GLB。对外 URL 统一走
# /optimize/serve-file，保证查看器收到的始终是正确的
# model/gltf-binary 响应。

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
        # 复制进 workspace/uploads 再服务：serve-file 只对 workspace 内（或
        # 临时转换目录）的文件放行，不允许按任意盘上路径取文件（文档 3.2）。
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        dest = UPLOAD_DIR / f'{uuid.uuid4().hex}.glb'
        try:
            shutil.copyfile(file_path, dest)
        except OSError as err:
            raise HTTPException(status_code=400, detail=f'unreadable file: {err}')
        return {'url': f'/optimize/serve-file?path={quote(str(dest))}'}

    # obj / stl / ply：在临时目录里转成 GLB。
    tmp_dir = tempfile.mkdtemp(prefix='meshforge_import_')
    output_path = os.path.join(tmp_dir, 'mesh.glb')
    try:
        import trimesh  # 惰性导入：仅非 GLB 转换时才需要
        loaded = trimesh.load(str(file_path))
        loaded.export(output_path)
    except Exception as err:  # noqa: BLE001 — surface a clean error, never 500-crash
        raise HTTPException(status_code=400, detail=f'unrecognised mesh: {err}')
    return {'url': f'/optimize/serve-file?path={quote(output_path)}'}


@router.get('/optimize/serve-file')
def serve_imported_file(path: str) -> FileResponse:
    """GET /optimize/serve-file：把 .glb 以正确的 MIME 类型返回。

    安全边界：仅允许 workspace 内的文件，或本应用创建的
    meshforge_import_* 临时转换目录内的文件；其余任意路径一律 403。
    （resolve + relative_to 归属校验，避免字符串前缀被兄弟目录骗过。）
    """
    file_path = Path(path).resolve()
    if not file_path.is_file():
        raise HTTPException(
            status_code=404,
            detail='file not found (temporary import dirs are cleared on restart — re-import the source mesh)',
        )
    if file_path.suffix.lower() != '.glb':
        raise HTTPException(status_code=400, detail='only GLB files can be served')
    if not (_within_workspace(file_path) or _within_import_temp(file_path)):
        raise HTTPException(
            status_code=403,
            detail='file outside workspace (paths saved by older versions are no longer accessible — re-import the mesh)',
        )
    return FileResponse(str(file_path), media_type='model/gltf-binary')
