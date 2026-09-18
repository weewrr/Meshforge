"""扩展节点用的网格处理工具（mesh → mesh）。

每个工具接收一个源网格路径、可选参数，并把结果写入 `out_dir`。
实现很轻量（仅 trimesh + numpy），因此可在 CPU 上运行，无需额外依赖。
"""

import logging
import threading
from pathlib import Path

import numpy as np
import trimesh

from generators.base import GenerationCancelled, ProgressFn

logger = logging.getLogger('mesh_tools')

# Taubin 平滑的 μ 系数比例：μ = -ratio * λ（经典取 0.5）。
# 先按 +λ 推、再按 +μ（负）拉，抵消纯 Laplacian 的体积收缩。
TAUBIN_MU_RATIO = 0.5
# 简化 / 重建后允许的最小面数，低于此值视为退化网格。
MIN_TOOL_FACES = 4
# 网格是三维的：顶点聚类的每轴缩放指数为 1/MESH_DIMENSIONS。
MESH_DIMENSIONS = 3

# 可选的重量级后端，用于 QEM 简化、补洞与非流形清理。
# 缺失时回退到纯 trimesh/numpy 路径，使工具链在无头环境依旧可用。
try:
    import pymeshlab  # type: ignore
    _HAS_PYMESHLAB = True
except Exception:  # noqa: BLE001 - 未安装 pymeshlab
    pymeshlab = None
    _HAS_PYMESHLAB = False


def _pm_ms(verts: np.ndarray, faces: np.ndarray):
    """Build a pymeshlab MeshSet from raw vertices/faces (no disk round-trip)."""
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=verts, face_matrix=faces))
    return ms


def _pm_out(ms) -> tuple[np.ndarray, np.ndarray]:
    """Extract (vertices, faces) back from a processed MeshSet."""
    m = ms.current_mesh()
    return m.vertex_matrix(), m.face_matrix()


def _pm_decimate(verts: np.ndarray, faces: np.ndarray, target_face_count: int):
    """Quadric Error Metric decimation to an approximate face count (QEM)."""
    target = max(4, int(target_face_count))
    ms = _pm_ms(verts, faces)
    ms.meshing_decimation_quadric_edge_collapse(
        targetfacenum=target, preserveboundary=True, preservenormal=True,
        optimalplacement=True, qualitythr=0.3,
    )
    return _pm_out(ms)


def _cancel_check(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise GenerationCancelled


def repair(mesh_path: Path, out_dir: Path, params: dict, progress: ProgressFn, cancel: threading.Event) -> Path:
    """修复网格：去除非流形、补洞、合并重复面/顶点，必要时转换法线。

    优先走 pymeshlab 重路径；任何失败都会回退到纯 trimesh 清理。
    """
    progress(0.1, 'loading mesh')
    _cancel_check(cancel)
    mesh = trimesh.load(mesh_path, force='mesh', process=False)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'repaired.glb'

    if _HAS_PYMESHLAB:
        # 稳健路径：修复非流形、补洞、丢弃重复/未引用元素。
        try:
            _cancel_check(cancel)
            progress(0.3, 'repairing (pymeshlab)')
            ms = _pm_ms(mesh.vertices, mesh.faces.astype(np.int32))
            ms.meshing_repair_non_manifold_edges()
            ms.meshing_repair_non_manifold_vertices()
            fill = str(params.get('fill_holes', 'auto'))
            if fill != 'off':
                ms.meshing_close_holes(maxholesize=100000, maxfacesize=100000)
            ms.meshing_remove_duplicate_faces()
            ms.meshing_remove_unreferenced_vertices()
            v, f = _pm_out(ms)
            trimesh.Trimesh(vertices=v, faces=f, process=False).export(out_path)
            progress(1.0, 'done')
            return out_path
        except Exception as exc:  # noqa: BLE001 - fall back to trimesh path on any failure
            logger.info('repair: pymeshlab path failed (%s); falling back to trimesh', exc)

    progress(0.4, 'repairing normals')
    if not mesh.is_watertight:
        trimesh.repair.fix_normals(mesh)
    fill = str(params.get('fill_holes', 'auto'))
    if fill == 'auto' and not mesh.is_watertight:
        progress(0.6, 'filling holes')
        try:
            trimesh.repair.fill_holes(mesh)
        except Exception as exc:  # noqa: BLE001 - fill_holes 需要额外库，仅尽力而为
            logger.debug('repair: fill_holes skipped (%s)', exc)
    _cancel_check(cancel)
    mesh.export(out_path)
    progress(1.0, 'done')
    return out_path


def smooth(mesh_path: Path, out_dir: Path, params: dict, progress: ProgressFn, cancel: threading.Event) -> Path:
    """对网格做 Taubin 平滑（λ/μ 两步），比纯 Laplacian 更能保持体积。"""
    progress(0.1, 'loading mesh')
    _cancel_check(cancel)
    mesh = trimesh.load(mesh_path, force='mesh', process=False)
    iterations = int(params.get('iterations', 3))
    lamb = float(params.get('lambda', 0.5))
    verts = mesh.vertices.copy()
    faces = mesh.faces

    # 只构建一次网格邻接（平滑过程中拓扑不变）：
    # 对每条有向边（v → 邻居）累加邻居坐标，
    # 并统计每个顶点的度。纯 numpy 实现，不需要 scipy。
    n = len(verts)
    row = np.concatenate([faces[:, 0], faces[:, 1], faces[:, 1], faces[:, 2], faces[:, 2], faces[:, 0]])
    col = np.concatenate([faces[:, 1], faces[:, 0], faces[:, 2], faces[:, 1], faces[:, 0], faces[:, 2]])
    deg = np.bincount(row, minlength=n).astype(np.float64)
    deg[deg == 0] = 1.0

    def neighbor_mean(v: np.ndarray) -> np.ndarray:
        """Mean of 1-ring neighbors for each vertex (rebuilt each call)."""
        acc = np.zeros((n, 3), dtype=np.float64)
        np.add.at(acc, row, v[col])
        return acc / deg[:, None]

    # Taubin λ/μ 平滑：每轮先用 +λ 推、再用 +μ（μ<0）拉。
    # 拉的阶段抵消纯 Laplacian 的体积收缩，从而保持网格整体而非塌陷。
    mu = -lamb * TAUBIN_MU_RATIO  # Taubin μ ≈ −0.5·λ：抵消纯 Laplacian 的体积收缩
    for i in range(iterations):
        _cancel_check(cancel)
        avg = neighbor_mean(verts)
        verts = verts + lamb * (avg - verts)
        avg = neighbor_mean(verts)
        verts = verts + mu * (avg - verts)
        progress(SMOOTH_PROGRESS_START + SMOOTH_PROGRESS_SPAN * (i + 1) / iterations, f'smoothing {i + 1}/{iterations}')

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'smoothed.glb'
    trimesh.Trimesh(vertices=verts, faces=faces, process=False).export(out_path)
    progress(1.0, 'done')
    return out_path


def remesher(mesh_path: Path, out_dir: Path, params: dict, progress: ProgressFn, cancel: threading.Event) -> Path:
    """把网格简化到近似目标面数。

    若已安装 pymeshlab 则使用二次误差度量（QEM）简化（保留细节最好）；
    否则回退到向量化的顶点聚类简化。
    """
    progress(0.1, 'loading mesh')
    _cancel_check(cancel)
    mesh = trimesh.load(mesh_path, force='mesh', process=False)
    target = int(params.get('target_faces', 10000))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'remeshed.glb'

    verts = mesh.vertices
    n = len(verts)
    if n <= target * 2:
        # 已足够小——仍然写出（保证幂等）。
        mesh.export(out_path)
        progress(1.0, 'done')
        return out_path

    if _HAS_PYMESHLAB:
        try:
            _cancel_check(cancel)
            progress(0.3, 'decimating (QEM)')
            v, f = _pm_decimate(verts, mesh.faces, target)
            if len(f) < MIN_TOOL_FACES:
                raise ValueError('qem produced too few faces')
            trimesh.Trimesh(vertices=v, faces=f, process=False).export(out_path)
            progress(1.0, 'done')
            return out_path
        except Exception as exc:  # noqa: BLE001 - fall back to numpy grid on failure
            logger.info('decimate: QEM path failed (%s); falling back to vertex clustering', exc)

    # 回退路径：向量化的顶点聚类简化。
    # 单元尺寸由目标面数推算：三维下每个单元约 (n / target) 个顶点。
    frac = (target / n) ** (1 / MESH_DIMENSIONS)
    lo, hi = verts.min(axis=0), verts.max(axis=0)
    span = np.maximum(hi - lo, 1e-6)
    cell = span * frac

    progress(0.4, 'clustering vertices')
    _cancel_check(cancel)
    keys = np.floor(verts / cell).astype(np.int64)
    # 把 (x,y,z) 元组映射到聚类 id
    unique, inverse = np.unique(keys, axis=0, return_inverse=True)
    cluster_count = len(unique)
    # 每个聚类的代表顶点 = 均值
    reps = np.zeros((cluster_count, 3), dtype=np.float64)
    counts = np.bincount(inverse, minlength=cluster_count).astype(np.float64)
    np.add.at(reps, inverse, verts)
    reps /= counts[:, None]

    progress(0.6, 'rebuilding faces')
    _cancel_check(cancel)
    # 全向量化重建面：把每个角点映射到其聚类，丢弃退化的面（同一单元里有两角点）。
    faces = mesh.faces
    ia = inverse[faces[:, 0]]
    ib = inverse[faces[:, 1]]
    ic = inverse[faces[:, 2]]
    keep = ~((ia == ib) | (ib == ic) | (ia == ic))
    if not keep.any():
        raise RuntimeError('remesh produced too few faces')
    new_faces = np.stack([ia[keep], ib[keep], ic[keep]], axis=1).astype(np.int64)
    if len(new_faces) < MIN_TOOL_FACES:
        raise RuntimeError('remesh produced too few faces')

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'remeshed.glb'
    trimesh.Trimesh(vertices=reps, faces=np.asarray(new_faces, dtype=np.int64), process=False).export(out_path)
    progress(1.0, 'done')
    return out_path


def optimizer(mesh_path: Path, out_dir: Path, params: dict, progress: ProgressFn, cancel: threading.Event) -> Path:
    progress(0.2, 'loading mesh')
    _cancel_check(cancel)
    mesh = trimesh.load(mesh_path, force='mesh', process=False)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'optimized.glb'
    merge = str(params.get('merge_vertices', 'on')) == 'on'

    if _HAS_PYMESHLAB and merge:
        # 完整清理：去重、剔除退化/翻转面、修复非流形。
        try:
            _cancel_check(cancel)
            progress(0.5, 'cleaning (pymeshlab)')
            ms = _pm_ms(mesh.vertices, mesh.faces.astype(np.int32))
            ms.meshing_merge_close_vertices(threshold=1e-6)
            ms.meshing_remove_null_faces()
            ms.meshing_remove_folded_faces()
            ms.meshing_remove_duplicate_faces()
            ms.meshing_repair_non_manifold_edges()
            ms.meshing_repair_non_manifold_vertices()
            ms.meshing_remove_unreferenced_vertices()
            v, f = _pm_out(ms)
            trimesh.Trimesh(vertices=v, faces=f, process=False).export(out_path)
            progress(1.0, 'done')
            return out_path
        except Exception as exc:  # noqa: BLE001 - fall back to trimesh merge
            logger.info('weld: pymeshlab path failed (%s); falling back to trimesh merge', exc)

    if merge:
        progress(0.5, 'merging duplicate vertices')
        mesh.merge_vertices(digits_vertex=6)
    _cancel_check(cancel)
    mesh.export(out_path)
    progress(1.0, 'done')
    return out_path


EXPORT_FORMATS = {'obj': '.obj', 'stl': '.stl', 'ply': '.ply'}


def exporter(mesh_path: Path, out_dir: Path, params: dict, progress: ProgressFn, cancel: threading.Event) -> Path:
    progress(0.2, 'loading mesh')
    _cancel_check(cancel)
    mesh = trimesh.load(mesh_path, force='mesh', process=False)
    fmt = str(params.get('format', 'obj'))
    suffix = EXPORT_FORMATS.get(fmt, '.obj')
    _cancel_check(cancel)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f'model{suffix}'
    mesh.export(out_path)
    progress(1.0, f'exported {fmt.upper()}')
    return out_path


TOOLS: dict[str, object] = {
    'mesh-repair': repair,
    'mesh-smoother': smooth,
    'mesh-remesher': remesher,
    'mesh-optimizer': optimizer,
    'mesh-exporter': exporter,
}


def faces_of(mesh: trimesh.Trimesh) -> np.ndarray:
    """返回网格的面索引数组（供调用方做轻量统计）。"""
    return mesh.faces
