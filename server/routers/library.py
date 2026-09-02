"""Workspace asset library index (Generate 页 Library 弹窗数据源)。

对齐 Modly 的 asset library 语义：把 workspace 下的产物文件索引为
带 sourceScope（workflows / exports）与 capability（mesh / scene-manifest 等）
的条目；只有 .glb/.gltf 可在 Generate 中打开。
"""
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter

router = APIRouter(tags=['library'])

WORKSPACE_DIR = Path(__file__).resolve().parent.parent / 'workspace'

MESH_EXTS = {'.glb', '.gltf', '.obj', '.ply', '.stl'}
OPENABLE_EXTS = {'.glb', '.gltf'}
# 原始输入（uploads 图片）不是库资产
SKIP_DIRS = {'uploads'}


def _mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def _entry(path: Path, base: Path, source_scope: str) -> dict:
    rel = path.relative_to(base).as_posix()
    suffix = path.suffix.lower()
    if suffix in MESH_EXTS:
        capability = 'mesh'
        openable = suffix in OPENABLE_EXTS
        reason = None if openable else 'Only .glb/.gltf workspace assets are openable in this release.'
        preview_kind = '3d-model'
    else:
        capability = 'scene-manifest'
        openable = False
        reason = 'This asset is tracked in the library but is not supported in Generate.'
        preview_kind = 'text'
    return {
        'id': f'{source_scope}:{rel}',
        'workspacePath': rel,
        'displayName': path.name,
        'sourceScope': source_scope,
        'capability': capability,
        'state': 'ready',
        'previewKind': preview_kind,
        'warnings': [],
        'openable': openable,
        'nonOpenableReason': reason,
        'createdAt': _mtime_iso(path),
        'updatedAt': _mtime_iso(path),
        'url': f'/files/{rel}',
    }


@router.get('/library')
def list_library() -> dict:
    base = WORKSPACE_DIR.resolve()
    base.mkdir(exist_ok=True)
    entries: list[dict] = []
    for path in sorted(base.rglob('*')):
        if not path.is_file():
            continue
        parts = path.relative_to(base).parts
        if parts[0] in SKIP_DIRS:
            continue
        suffix = path.suffix.lower()
        if suffix not in MESH_EXTS and suffix != '.json':
            continue
        source_scope = 'workflows' if parts[0] == 'workflows' else 'exports'
        entries.append(_entry(path, base, source_scope))
    return {'success': True, 'entries': entries}
