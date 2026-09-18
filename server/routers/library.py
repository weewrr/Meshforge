"""工作区资产库索引（Generate 页 Library 弹窗的数据源）。

对齐 Modly 的 asset library 语义：把 workspace 下的产物文件索引为条目，
每个条目带 sourceScope（workflows / exports）与 capability（mesh /
scene-manifest 等）；本版本只有 .glb / .gltf 允许在 Generate 页打开。

扫描治理（优化文档 6.2）：
- **签名缓存**：每次请求先用 os.walk 走一遍目录算"轻量签名"（候选文件的
  相对路径 + mtime_ns + size 元组序列）；签名没变就直接复用上次构建好的
  条目列表，跳过条目构建与排序。文件被原地改写（如工作流 JSON 保存）时
  mtime_ns 变化，签名随之失效，不存在脏缓存。
- **分页**：`limit` / `offset` 查询参数控制单页大小（默认 200、上限 1000），
  避免大工作区一次性序列化几千条目拖慢响应；`total` 供前端判断是否还有下一页。
"""
import os
import threading
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from fastapi import APIRouter

from config import WORKSPACE_DIR
from schemas import LibraryOut

router = APIRouter(tags=['library'])

# 所有被视为"网格资产"的后缀（用于判定 capability 与预览类型）。
MESH_EXTS = {'.glb', '.gltf', '.obj', '.ply', '.stl'}
# 其中真正能在 Generate 页被 3D 查看器打开的只有这两个。
OPENABLE_EXTS = {'.glb', '.gltf'}
# 原始输入（uploads 图片）不是库资产
SKIP_DIRS = {'uploads'}
# 入索引的候选后缀 = 网格 + scene-manifest JSON。
CANDIDATE_EXTS = MESH_EXTS | {'.json'}
# 分页边界。
DEFAULT_PAGE_LIMIT = 200
MAX_PAGE_LIMIT = 1000

# ─── 签名缓存 ────────────────────────────────────────────────────────────────
_lock = threading.Lock()
_sig_cache: tuple[tuple, ...] | None = None
_entries_cache: list[dict] = []


def _mtime_iso(mtime_ns: int) -> str:
    """纳秒精度 mtime → 带时区的 ISO 8601（前端 new Date() 可直接解析）。"""
    return datetime.fromtimestamp(mtime_ns / 1e9, tz=timezone.utc).isoformat()


def _entry(rel_posix: str, name: str, mtime_ns: int, source_scope: str) -> dict:
    """把一个候选文件的元信息转成前端 LibraryEntry 结构。

    Args:
        rel_posix: 相对 workspace 的 POSIX 风格路径（url 与 id 的原料）。
        name: 文件名（displayName）。
        mtime_ns: 文件修改时间（纳秒），同时充当 createdAt / updatedAt。
        source_scope: 'workflows' 或 'exports'，表示该资产来自哪个产出域。

    Returns:
        序列化给前端的条目字典；`url` 指向后端静态文件挂载点 `/files/...`。
    """
    suffix = PurePosixPath(rel_posix).suffix.lower()
    if suffix in MESH_EXTS:
        capability = 'mesh'
        openable = suffix in OPENABLE_EXTS
        # 不可打开时给出明确原因，前端据此显示灰置提示而不是静默失败。
        reason = None if openable else 'Only .glb/.gltf workspace assets are openable in this release.'
        preview_kind = '3d-model'
    else:
        capability = 'scene-manifest'
        openable = False
        reason = 'This asset is tracked in the library but is not supported in Generate.'
        preview_kind = 'text'
    iso = _mtime_iso(mtime_ns)
    return {
        'id': f'{source_scope}:{rel_posix}',
        'workspacePath': rel_posix,
        'displayName': name,
        'sourceScope': source_scope,
        'capability': capability,
        'state': 'ready',
        'previewKind': preview_kind,
        'warnings': [],
        'openable': openable,
        'nonOpenableReason': reason,
        'createdAt': iso,
        'updatedAt': iso,
        'url': f'/files/{rel_posix}',
    }


def _scan(base: str) -> tuple[tuple[tuple, ...], list[dict]]:
    """遍历 workspace，返回 (签名, 条目列表)。

    os.scandir 递归实现：Windows 上 stat 信息直接来自目录枚举，无需对每个
    文件再单独 stat，比 `rglob + stat` 便宜一截。uploads 顶层目录整棵剪枝。
    """
    signature: list[tuple] = []
    candidates: list[tuple[str, str, int, str]] = []

    def walk(dir_path: str, rel_parts: tuple[str, ...]) -> None:
        try:
            with os.scandir(dir_path) as it:
                for e in it:
                    rel = rel_parts + (e.name,)
                    if e.is_dir(follow_symlinks=False):
                        # 只跳过顶层的 uploads：深层同名目录仍按正常资产处理。
                        if len(rel) == 1 and rel[0] in SKIP_DIRS:
                            continue
                        walk(e.path, rel)
                        continue
                    if not e.is_file(follow_symlinks=False):
                        continue
                    suffix = os.path.splitext(e.name)[1].lower()
                    if suffix not in CANDIDATE_EXTS:
                        continue
                    st = e.stat(follow_symlinks=False)
                    rel_posix = '/'.join(rel)
                    # 签名只取"会影响条目内容"的三元组：路径 + mtime + 大小。
                    signature.append((rel_posix, st.st_mtime_ns, st.st_size))
                    source_scope = 'workflows' if rel[0] == 'workflows' else 'exports'
                    candidates.append((rel_posix, e.name, st.st_mtime_ns, source_scope))
        except OSError:
            return  # 目录消失 / 权限问题：按空处理，不让单点故障拖垮整个接口

    walk(base, ())
    signature.sort()
    candidates.sort()
    entries = [_entry(rel, name, mt, scope) for rel, name, mt, scope in candidates]
    return tuple(signature), entries


def _library_entries(base: str) -> list[dict]:
    """带缓存的条目获取：签名未变直接复用上次结果（进程内共享，加锁保护）。"""
    global _sig_cache, _entries_cache
    sig, entries = _scan(base)
    with _lock:
        if sig != _sig_cache:
            _sig_cache = sig
            _entries_cache = entries
        return _entries_cache


@router.get('/library', response_model=LibraryOut)
def list_library(offset: int = 0, limit: int = DEFAULT_PAGE_LIMIT) -> dict:
    """GET /library — 分页列出 workspace 下可索引的资产。

    Args:
        offset: 起始下标（默认 0）。
        limit: 单页条数，默认 200，上限 1000；传 0 表示不限（老客户端兼容）。

    Returns:
        `{'success': True, 'total': N, 'offset': o, 'limit': l, 'entries': [...]}`；
        entries 按路径排序，保证顺序稳定。
    """
    base = str(WORKSPACE_DIR.resolve())
    # 首次调用时 workspace 可能还不存在，先建出来再扫描，避免抛异常。
    Path(base).mkdir(exist_ok=True)

    entries = _library_entries(base)
    if limit <= 0 or limit > MAX_PAGE_LIMIT:
        limit = len(entries) if limit <= 0 else MAX_PAGE_LIMIT
    page = entries[max(0, offset):max(0, offset) + limit]
    return {
        'success': True,
        'total': len(entries),
        'offset': max(0, offset),
        'limit': limit,
        'entries': page,
    }
