"""缓存 / 临时文件清理端点。

对应「设置 → 存储 → 清除缓存」操作。只删除真正临时的文件——被已保存工作流
引用的、模型产物（workspace/<job>/model.glb）、工作流元数据一律不动。

策略：
  * uploads/ —— 删掉未被任何*已保存*工作流节点引用的文件。
    未保存的画布不会被参考，因此进行中的编辑可能丢失其上传；
    渲染进程在调用本端点前会先警告用户。
  * 操作系统临时目录 —— 清除残留的 `meshforge_import_*` GLB 转换目录
    （generate.py 用 mkdtemp 创建它们却从不清理）。
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from fastapi import APIRouter

from config import DATA_DIR, EXTENSIONS_DIR, MODELS_DIR, WORKSPACE_DIR
from schemas import RuntimeOut

router = APIRouter(tags=['settings'])

UPLOAD_DIR = WORKSPACE_DIR / 'uploads'
WORKFLOWS_DIR = WORKSPACE_DIR / 'workflows'


@router.get('/settings/runtime', response_model=RuntimeOut)
def runtime_info() -> dict:
    """GET /settings/runtime — 后端运行时真实生效配置（优化文档 13.2 设置契约）。

    前端设置页据此展示"实际生效"的目录与端口，而不是 localStorage 里
    可能已经失真的副本；`wired` 明确标出哪些前端设置项后端尚未接线，
    避免用户误以为改动已生效。
    """
    from jobs import MAX_CONCURRENT_PER_GENERATOR  # 延迟导入避免循环依赖
    from routers.system_stats import detect_gpu  # GPU 静态探测（进程内缓存）

    return {
        'dataDir': str(DATA_DIR),
        'workspaceDir': str(WORKSPACE_DIR),
        'workflowsDir': str(WORKSPACE_DIR / 'workflows'),
        'modelsDir': str(MODELS_DIR),
        'extensionsDir': str(EXTENSIONS_DIR),
        'port': int(os.environ.get('MESHFORGE_API_PORT') or 8766),
        'maxConcurrentPerModel': MAX_CONCURRENT_PER_GENERATOR,
        # 启动探测的 GPU 信息：设置页据此展示"auto 档实际会落在哪"，
        # 无 N 卡时明确提示降级 CPU（优化文档 6.3）。
        'gpu': detect_gpu(),
        # 前端设置项 → 后端是否已接线。 false = 仅存 localStorage，不生效。
        'wired': {
            'gpuDevice': False,
            'fp16': False,
            'vramLimit': False,
            'parallelWorkers': False,
            'modelsDir': False,
            'workspaceDir': False,
        },
    }


def _collect_upload_refs(obj, referenced: set[str]) -> None:
    """递归收集结构里所有引用 uploads/ 的文件名。

    不只扫节点顶层 `data.url`：子图、数组参数与未来扩展字段里嵌套的
    字符串一律要覆盖到，否则清理缓存会误删仍被引用的上传资源（文档 4.2）。
    """
    if isinstance(obj, dict):
        for value in obj.values():
            _collect_upload_refs(value, referenced)
    elif isinstance(obj, list):
        for item in obj:
            _collect_upload_refs(item, referenced)
    elif isinstance(obj, str) and '/uploads/' in obj:
        referenced.add(obj.rsplit('/uploads/', 1)[-1])


def _referenced_upload_names() -> set[str]:
    """Collect upload filenames that saved workflows still reference."""
    referenced: set[str] = set()
    if not WORKFLOWS_DIR.is_dir():
        return referenced
    for wf_path in WORKFLOWS_DIR.glob('*.json'):
        try:
            import json

            data = json.loads(wf_path.read_text(encoding='utf-8'))
        except Exception:
            continue
        if isinstance(data, dict):
            _collect_upload_refs(data.get('nodes', []), referenced)
    return referenced


@router.post('/settings/clear-cache')
def clear_cache() -> dict:
    """Delete temporary caches; report what was removed."""
    removed_files = 0
    freed_bytes = 0

    # — uploads not referenced by a saved workflow —
    referenced = _referenced_upload_names()
    if UPLOAD_DIR.is_dir():
        for f in UPLOAD_DIR.iterdir():
            if not f.is_file() or f.name in referenced:
                continue
            try:
                size = f.stat().st_size
                f.unlink()
                removed_files += 1
                freed_bytes += size
            except OSError:
                continue

    # — leftover meshforge_import_* conversion dirs in the OS temp dir —
    try:
        tmp_root = Path(tempfile.gettempdir())
        for d in tmp_root.glob('meshforge_import_*'):
            if not d.is_dir():
                continue
            try:
                size = sum(p.stat().st_size for p in d.rglob('*') if p.is_file())
                shutil.rmtree(d, ignore_errors=True)
                removed_files += 1
                freed_bytes += size
            except OSError:
                continue
    except OSError:
        pass

    return {
        'ok': True,
        'removed': removed_files,
        'freedBytes': freed_bytes,
    }


@router.post('/settings/open-cache-folder')
def open_cache_folder() -> dict:
    """Reveal the cache (uploads) directory in the OS file manager."""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    target = str(UPLOAD_DIR)
    try:
        if sys.platform == 'win32':
            os.startfile(target)  # type: ignore[attr-defined]
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', target])
        else:
            subprocess.Popen(['xdg-open', target])
        return {'ok': True, 'path': target}
    except Exception as e:  # noqa: BLE001
        return {'ok': False, 'error': str(e), 'path': target}


@router.post('/settings/clear-generated')
def clear_generated() -> dict:
    """Delete generated model outputs (workspace/<job>/model.glb and siblings).

    Keeps uploads, invocation payloads and workflow metadata — only the per-job
    output directory (everything produced under workspace/<job>) is removed.
    """
    removed_dirs = 0
    freed_bytes = 0
    if WORKSPACE_DIR.is_dir():
        for job_dir in WORKSPACE_DIR.iterdir():
            if not job_dir.is_dir():
                continue
            # 只清理真正含有生成产物的任务目录
            if not any(p.suffix.lower() in ('.glb', '.gltf', '.obj', '.stl')
                       for p in job_dir.rglob('*')):
                continue
            try:
                size = sum(p.stat().st_size for p in job_dir.rglob('*') if p.is_file())
                shutil.rmtree(job_dir, ignore_errors=True)
                removed_dirs += 1
                freed_bytes += size
            except OSError:
                continue
    return {'ok': True, 'removed': removed_dirs, 'freedBytes': freed_bytes}


@router.post('/settings/clear-workflows')
def clear_workflows() -> dict:
    """Delete all saved workflows (workspace/workflows/*.json).

    Keeps uploads, cache and generated outputs untouched — only the persisted
    workflow definitions are removed.
    """
    removed_files = 0
    freed_bytes = 0
    if WORKFLOWS_DIR.is_dir():
        for f in WORKFLOWS_DIR.glob('*.json'):
            if not f.is_file():
                continue
            try:
                size = f.stat().st_size
                f.unlink()
                removed_files += 1
                freed_bytes += size
            except OSError:
                continue
    return {'ok': True, 'removed': removed_files, 'freedBytes': freed_bytes}