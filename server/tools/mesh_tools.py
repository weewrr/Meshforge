"""Mesh processing tools (mesh → mesh) for extension nodes.

Each tool takes a source mesh path, optional params, and writes a result into
out_dir. Implementations are lightweight (trimesh + numpy) so they run on CPU
without extra dependencies.
"""

import threading
from pathlib import Path

import numpy as np
import trimesh

from generators.base import GenerationCancelled, ProgressFn


def _cancel_check(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise GenerationCancelled


def repair(mesh_path: Path, out_dir: Path, params: dict, progress: ProgressFn, cancel: threading.Event) -> Path:
    progress(0.1, 'loading mesh')
    _cancel_check(cancel)
    mesh = trimesh.load(mesh_path, force='mesh', process=False)
    progress(0.4, 'repairing normals')
    if not mesh.is_watertight:
        trimesh.repair.fix_normals(mesh)
    fill = str(params.get('fill_holes', 'auto'))
    if fill == 'auto' and not mesh.is_watertight:
        progress(0.6, 'filling holes')
        try:
            trimesh.repair.fill_holes(mesh)
        except Exception:
            pass  # fill_holes needs an extra lib; best-effort only
    _cancel_check(cancel)
    out_path = out_dir / 'repaired.glb'
    out_dir.mkdir(parents=True, exist_ok=True)
    mesh.export(out_path)
    progress(1.0, 'done')
    return out_path


def smooth(mesh_path: Path, out_dir: Path, params: dict, progress: ProgressFn, cancel: threading.Event) -> Path:
    progress(0.1, 'loading mesh')
    _cancel_check(cancel)
    mesh = trimesh.load(mesh_path, force='mesh', process=False)
    iterations = int(params.get('iterations', 3))
    lamb = float(params.get('lambda', 0.5))
    verts = mesh.vertices.copy()
    faces = mesh.faces

    # Build adjacency via scatter: for every directed edge (v → neighbor),
    # accumulate neighbor coordinates and a degree count per vertex.
    n = len(verts)
    row = np.concatenate([faces[:, 0], faces[:, 1], faces[:, 1], faces[:, 2], faces[:, 2], faces[:, 0]])
    col = np.concatenate([faces[:, 1], faces[:, 0], faces[:, 2], faces[:, 1], faces[:, 0], faces[:, 2]])
    neighbor_sum = np.zeros((n, 3), dtype=np.float64)
    np.add.at(neighbor_sum, row, verts[col])
    deg = np.bincount(row, minlength=n).astype(np.float64)
    deg[deg == 0] = 1.0

    for i in range(iterations):
        _cancel_check(cancel)
        avg = neighbor_sum / deg[:, None]
        verts = verts + lamb * (avg - verts)
        progress(0.3 + 0.6 * (i + 1) / iterations, f'smoothing {i + 1}/{iterations}')

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'smoothed.glb'
    trimesh.Trimesh(vertices=verts, faces=faces, process=False).export(out_path)
    progress(1.0, 'done')
    return out_path


def remesher(mesh_path: Path, out_dir: Path, params: dict, progress: ProgressFn, cancel: threading.Event) -> Path:
    """Simplify via vertex clustering (quantize vertices into a grid)."""
    progress(0.1, 'loading mesh')
    _cancel_check(cancel)
    mesh = trimesh.load(mesh_path, force='mesh', process=False)
    target = int(params.get('target_faces', 10000))
    verts = mesh.vertices
    n = len(verts)
    if n <= target * 2:
        # Already small enough — still write out (idempotent).
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / 'remeshed.glb'
        mesh.export(out_path)
        progress(1.0, 'done')
        return out_path

    # Cell size from target: roughly (n / target) vertices per cell in 3D.
    frac = (target / n) ** (1 / 3)
    lo, hi = verts.min(axis=0), verts.max(axis=0)
    span = np.maximum(hi - lo, 1e-6)
    cell = span * frac

    progress(0.4, 'clustering vertices')
    _cancel_check(cancel)
    keys = np.floor(verts / cell).astype(np.int64)
    # Map (x,y,z) tuple → cluster id
    unique, inverse = np.unique(keys, axis=0, return_inverse=True)
    cluster_count = len(unique)
    # Representative vertex per cluster = mean
    reps = np.zeros((cluster_count, 3), dtype=np.float64)
    counts = np.bincount(inverse, minlength=cluster_count).astype(np.float64)
    np.add.at(reps, inverse, verts)
    reps /= counts[:, None]

    progress(0.6, 'rebuilding faces')
    _cancel_check(cancel)
    new_faces = []
    for a, b, c in faces_of(mesh):
        ia, ib, ic = inverse[a], inverse[b], inverse[c]
        if ia == ib or ib == ic or ia == ic:
            continue
        new_faces.append((ia, ib, ic))
    if len(new_faces) < 4:
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
    if str(params.get('merge_vertices', 'on')) == 'on':
        progress(0.5, 'merging duplicate vertices')
        mesh.merge_vertices(digits_vertex=6)
    _cancel_check(cancel)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'optimized.glb'
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
    return mesh.faces
