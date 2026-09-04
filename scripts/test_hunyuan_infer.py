"""End-to-end smoke test for the local Hunyuan3D-2-mini weights.

Usage (inside the hy3dgen venv):
  hy3dgen-venv/Scripts/python.exe test_hunyuan_infer.py ^
      --model-root D:/github/models ^
      --image server/workspace/uploads/test_apple.png ^
      --out server/workspace/uploads/test_apple.glb ^
      --steps 8

Loads Hunyuan3D-2mini/hunyuan3d-dit-v2-mini via the HY3DGEN_MODELS layout,
runs image-to-shape and exports GLB.
"""

import argparse
import os
import sys
import time
from pathlib import Path

import torch
import trimesh


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-root', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--out', default='out.glb')
    parser.add_argument('--steps', type=int, default=8)
    parser.add_argument('--guidance', type=float, default=4.0)
    parser.add_argument('--octree', type=int, default=256)
    parser.add_argument('--device', default='auto')
    args = parser.parse_args()

    device = args.device
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if device == 'cuda' else torch.float32
    print(f'[test] device={device} dtype={dtype} steps={args.steps} '
          f'guidance={args.guidance} octree={args.octree}', flush=True)

    os.environ['HY3DGEN_MODELS'] = args.model_root
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

    t0 = time.time()
    pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        'Hunyuan3D-2mini',
        subfolder='hunyuan3d-dit-v2-mini',
        device=device,
        dtype=dtype,
    )
    pipeline.to(device, dtype)
    print(f'[test] pipeline loaded in {time.time() - t0:.1f}s', flush=True)
    if device == 'cuda':
        print(f'[test] VRAM after load: '
              f'{torch.cuda.memory_allocated() / 1e9:.2f} GB / '
              f'{torch.cuda.memory_reserved() / 1e9:.2f} GB reserved', flush=True)

    t1 = time.time()
    with torch.inference_mode():
        result = pipeline(
            args.image,
            num_inference_steps=args.steps,
            guidance_scale=args.guidance,
            octree_resolution=args.octree,
            box_v=1.01,
            mc_level=0.0,
        )
    print(f'[test] inference done in {time.time() - t1:.1f}s', flush=True)
    if device == 'cuda':
        print(f'[test] peak VRAM: {torch.cuda.max_memory_allocated() / 1e9:.2f} GB',
              flush=True)

    # result: List[List[trimesh.Trimesh]] (batch x items)
    items = result[0] if isinstance(result, (list, tuple)) else result
    mesh = items[0] if isinstance(items, (list, tuple)) else items
    if not isinstance(mesh, trimesh.Trimesh):
        raise SystemExit(f'unexpected result type: {type(mesh)}')
    print(f'[test] mesh: {len(mesh.vertices)} verts, {len(mesh.faces)} faces',
          flush=True)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    mesh.export(out_path)
    print(f'[test] saved {out_path} '
          f'({out_path.stat().st_size / 1e6:.2f} MB)', flush=True)


if __name__ == '__main__':
    main()
