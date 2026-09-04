"""MeshForge Hunyuan3D-2-mini inference service (standalone process).

This service is the *model side* of the Hunyuan3DGenerator adapter in
``generators/hunyuan.py``. It loads the Hunyuan3D-2-mini weights from a local
directory (HY3DGEN_MODELS, see ``smart_load_model`` in the hy3dgen package)
and exposes two endpoints that match what the MeshForge generator expects:

  GET  /health              -> {"status": "ok", "model": ..., "loaded": bool}
  POST /generate            -> multipart: image file + steps/guidance
                               returns the generated mesh as GLB bytes

It must run inside the *hy3dgen* virtualenv (Python 3.11 + torch cu12x +
hy3dgen + pymeshlab ...), NOT inside the lightweight MeshForge server venv.
Typical launch:

  D:/github/hy3dgen-venv/Scripts/python.exe hunyuan_service.py
    --model-root D:/github/models
    --port 8767

While the service is running, set MESHFORGE_HUNYUAN_URL=http://127.0.0.1:8767
for the MeshForge backend (or leave the default in generators/hunyuan.py).
"""

import argparse
import io
import os
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import Response

# ─── Heavy imports are deferred to module load so --help / docs stay light ──
_IMPORT_LOCK = threading.Lock()
_PIPELINE = None
_PIPELINE_DEVICE = None
_PIPELINE_LOCK = threading.Lock()  # 6 GB VRAM only fits one job at a time
_START = time.time()

# Endpoint contract defaults shared with generators/hunyuan.py
DEFAULT_STEPS = 20
DEFAULT_GUIDANCE = 4.0
DEFAULT_OCTREE = 256
DEFAULT_BOX_V = 1.01
DEFAULT_SEED = -1  # <0 => random each run; >=0 => reproducible


def _load_pipeline(model_root: str, device: str) -> object:
    """Lazily build the Hy3D pipeline singleton."""
    global _PIPELINE, _PIPELINE_DEVICE
    with _IMPORT_LOCK:
        if _PIPELINE is not None:
            return _PIPELINE

        import torch
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

        if device == 'auto':
            device = 'cuda' if torch.cuda.is_available() else 'cpu'
        dtype = torch.float16 if device == 'cuda' else torch.float32
        if device == 'cuda':
            print(f'[hunyuan] CUDA device: {torch.cuda.get_device_name(0)} '
                  f'({torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB)',
                  flush=True)

        os.environ['HY3DGEN_MODELS'] = model_root
        pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
            'Hunyuan3D-2mini',
            subfolder='hunyuan3d-dit-v2-mini',
            device=device,
            dtype=dtype,
        )
        pipeline.to(device, dtype)
        _PIPELINE, _PIPELINE_DEVICE = pipeline, device
        return pipeline


def _remove_base_disc(mesh) -> object:
    """Cut the thin support disc Hunyuan often adds at the bottom.

    Detection: scan the lowest 15% of the mesh in thin y-layers; the disc layer
    packs far more vertices than any body layer (flat cap) — the first sudden
    drop locates the disc top. Remove everything below it and cap the planar
    hole with a pure-trimesh fan (no pymeshlab on the hot path — its C++ layer
    can segfault the whole service when a filter fails on a non-manifold cut).
    """
    import trimesh

    v = mesh.vertices
    y0 = float(v[:, 1].min())
    h = float(v[:, 1].max()) - y0
    if h <= 0 or len(mesh.faces) == 0:
        return mesh

    layer_h = h * 0.02
    prev = 0
    cut = None
    y = y0
    while y - y0 < h * 0.15 - 1e-9:
        band = v[(v[:, 1] >= y) & (v[:, 1] < y + layer_h)]
        n = len(band)
        if prev > 0 and n > 0 and n < 0.35 * prev and (y - y0) > h * 0.005:
            cut = y
            break
        if n > prev:
            prev = n
        y += layer_h

    if cut is None or cut - y0 < h * 0.005:
        return mesh  # no obvious flat disc

    # Safety gate: only cut when the bottom layer clearly overhangs the body
    # above (r_below > 1.05 * r_above). A genuine flat-bottom object (mug,
    # block, vase) has the same footprint as its body and must NOT be cut.
    import numpy as _np

    cx = float(v[:, 0].mean())
    cz = float(v[:, 2].mean())
    rad2 = (v[:, 0] - cx) ** 2 + (v[:, 2] - cz) ** 2
    below = rad2[(v[:, 1] >= y0) & (v[:, 1] < cut)]
    above = rad2[v[:, 1] >= cut + layer_h * 2]
    if len(below) == 0 or len(above) == 0:
        return mesh
    r_below = float(_np.sqrt(below.max()))
    r_above = float(_np.sqrt(above.max()))
    if r_above <= 0 or r_below <= 1.05 * r_above:
        return mesh  # bottom is not wider than the body — not a support disc

    keep = v[mesh.faces, 1].min(axis=1) >= cut - 1e-5
    if keep.all():
        return mesh

    faces = mesh.faces[keep]
    out = trimesh.Trimesh(vertices=v, faces=faces, process=True)
    if out.is_watertight:
        return out

    # Cap boundary hole(s): walk the open edge ring, fan-triangulate to centroid.
    es = _np.sort(out.edges, axis=1)
    uniq, counts = _np.unique(es, axis=0, return_counts=True)
    boundary = uniq[counts == 1]
    if len(boundary) == 0:
        return out

    # Walk the ring (every boundary vertex has degree 2 on the ring).
    adj: dict = {}
    for be in boundary:
        a, b = int(be[0]), int(be[1])
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)

    start = int(boundary[0, 0])
    ring = [start]
    cur, prev_v = start, -1
    while True:
        nbrs = [x for x in adj.get(cur, []) if x != prev_v]
        if not nbrs:
            break
        nxt = nbrs[0]
        if nxt == start and len(ring) > 2:
            break
        ring.append(nxt)
        prev_v, cur = cur, nxt
        if len(ring) > len(adj) + 2:
            break

    if len(ring) < 3:
        return out

    rv = out.vertices[ring]
    cx, cz = float(rv[:, 0].mean()), float(rv[:, 2].mean())
    cy = float(rv[:, 1].mean())
    center_idx = len(out.vertices)
    out_verts = _np.vstack([out.vertices, [[cx, cy, cz]]])
    n = len(ring)
    fan = [(ring[i], center_idx, ring[(i + 1) % n]) for i in range(n)]
    tmp = trimesh.Trimesh(
        vertices=out_verts,
        faces=_np.vstack([out.faces, _np.asarray(fan, dtype=_np.int64)]),
        process=False,
    )
    if not tmp.is_watertight:
        fan = [(ring[i], ring[(i + 1) % n], center_idx) for i in range(n)]
        tmp = trimesh.Trimesh(
            vertices=out_verts,
            faces=_np.vstack([out.faces, _np.asarray(fan, dtype=_np.int64)]),
            process=False,
        )
    return tmp


def _to_glb(result, reduce_faces: bool, remove_base: bool = True) -> bytes:
    """Flatten the pipeline result (List[List[Trimesh]]) and export GLB bytes."""
    import trimesh

    meshes = result[0] if isinstance(result, (list, tuple)) else result
    if isinstance(meshes, (list, tuple)):
        mesh = meshes[0]
    else:
        mesh = meshes

    if mesh is None:
        raise RuntimeError('pipeline returned no mesh')
    if len(mesh.faces) == 0 or len(mesh.vertices) == 0:
        raise RuntimeError('pipeline returned an empty mesh')

    if remove_base:
        mesh = _remove_base_disc(mesh)

    if reduce_faces and len(mesh.faces) > 120_000:
        try:
            from hy3dgen.shapegen import FaceReducer
            mesh = FaceReducer()(mesh, max_facenum=120_000)
        except Exception as exc:  # noqa: BLE001 - simplification is best-effort
            print(f'[hunyuan] face reduction skipped: {exc}', flush=True)

    if isinstance(mesh, trimesh.Trimesh):
        buf = io.BytesIO()
        mesh.export(buf, file_type='glb')
        return buf.getvalue()
    raise RuntimeError(f'unexpected pipeline output type: {type(mesh)}')


app = FastAPI(title='MeshForge Hunyuan3D-2-mini inference', version='1.0.0')


@app.get('/health')
def health() -> dict:
    return {
        'status': 'ok',
        'model': 'Hunyuan3D-2-mini',
        'loaded': _PIPELINE is not None,
        'uptime_s': int(time.time() - _START),
    }


@app.post('/generate')
async def generate(
    image: UploadFile = File(...),
    steps: int = Form(DEFAULT_STEPS),
    guidance: float = Form(DEFAULT_GUIDANCE),
    octree: int = Form(DEFAULT_OCTREE),
    seed: int = Form(DEFAULT_SEED),
    remove_base: int = Form(1),
) -> Response:
    model_root = os.environ.get('HY3DGEN_MODELS', '')
    if not model_root:
        return Response('HY3DGEN_MODELS not configured on the service', status_code=500)

    try:
        pipeline = _load_pipeline(model_root, os.environ.get('HY3DGEN_DEVICE', 'auto'))
    except Exception as exc:  # noqa: BLE001
        return Response(f'model load failed: {exc}', status_code=500)

    with tempfile.TemporaryDirectory(prefix='hy3d_') as tmp:
        suffix = Path(image.filename or 'input.png').suffix or '.png'
        src = Path(tmp) / f'input{suffix}'
        src.write_bytes(await image.read())

        try:
            with _PIPELINE_LOCK:  # one inference at a time
                gen = None
                if int(seed) >= 0:
                    import torch
                    gen = torch.Generator(device=_PIPELINE_DEVICE or 'cpu').manual_seed(int(seed))
                out = pipeline(
                    str(src),
                    num_inference_steps=int(steps),
                    guidance_scale=float(guidance),
                    octree_resolution=int(octree),
                    box_v=DEFAULT_BOX_V,
                    mc_level=0.0,
                    generator=gen,
                )
            payload = _to_glb(out, reduce_faces=True, remove_base=int(remove_base) != 0)
        except Exception as exc:  # noqa: BLE001 - surface a clean error
            return Response(f'inference failed: {exc}', status_code=500)

    if not payload:
        return Response('empty mesh produced', status_code=500)
    return Response(content=payload, media_type='model/gltf-binary')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-root', default=os.environ.get('HY3DGEN_MODELS', ''),
                        help='parent dir of the Hunyuan3D-2mini weights folder')
    parser.add_argument('--port', type=int, default=8767)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--device', default=os.environ.get('HY3DGEN_DEVICE', 'auto'),
                        help='auto | cuda | cpu')
    parser.add_argument('--preload', action='store_true',
                        help='load model weights at startup (instead of on first /generate)')
    args = parser.parse_args()

    if not args.model_root:
        print('error: --model-root is required (e.g. D:/github/models)')
        raise SystemExit(2)
    os.environ['HY3DGEN_MODELS'] = args.model_root
    if args.device:
        os.environ['HY3DGEN_DEVICE'] = args.device

    if args.preload:
        import threading

        def _warmup() -> None:
            print('[hunyuan] preloading model weights ...', flush=True)
            try:
                _load_pipeline(args.model_root, args.device)
                print('[hunyuan] model preloaded', flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f'[hunyuan] preload FAILED: {exc}', flush=True)

        threading.Thread(target=_warmup, daemon=True).start()

    import uvicorn

    print(f'[hunyuan] model root: {args.model_root} (preload={"on" if args.preload else "off"})',
          flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')
