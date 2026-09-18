"""对本地 Hunyuan3D-2-mini 权重做端到端冒烟测试。

用法（在 hy3dgen 虚拟环境内执行）：
  hy3dgen-venv/Scripts/python.exe test_hunyuan_infer.py ^
      --model-root D:/github/models ^
      --image server/workspace/uploads/test_apple.png ^
      --out server/workspace/uploads/test_apple.glb ^
      --steps 8

按 `HY3DGEN_MODELS` 的目录布局加载 Hunyuan3D-2mini/hunyuan3d-dit-v2-mini，
跑图生形状（image-to-shape）并导出 GLB。
"""

import argparse
import os
import sys
import time
from pathlib import Path

import torch
import trimesh


def main() -> None:
    """解析参数、加载管线、跑一次推理并导出 GLB。"""
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-root', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--out', default='out.glb')
    parser.add_argument('--steps', type=int, default=8)
    parser.add_argument('--guidance', type=float, default=4.0)
    parser.add_argument('--octree', type=int, default=256)
    parser.add_argument('--device', default='auto')
    args = parser.parse_args()

    # auto 时优先用 CUDA；dtype 随之切换（fp16 在 CPU 上不受支持）。
    device = args.device
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if device == 'cuda' else torch.float32
    print(f'[test] device={device} dtype={dtype} steps={args.steps} '
          f'guidance={args.guidance} octree={args.octree}', flush=True)

    # 必须在 import hy3dgen 之前设置，否则管线会去找默认的权重目录。
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
        # 便于判断是否逼近显存上限（mini 权重 + 高 octree 容易 OOM）。
        print(f'[test] VRAM after load: '
              f'{torch.cuda.memory_allocated() / 1e9:.2f} GB / '
              f'{torch.cuda.memory_reserved() / 1e9:.2f} GB reserved', flush=True)

    # inference_mode 比 no_grad 更彻底地关掉 autograd 记录，省显存也更快。
    t1 = time.time()
    with torch.inference_mode():
        result = pipeline(
            args.image,
            num_inference_steps=args.steps,
            guidance_scale=args.guidance,
            octree_resolution=args.octree,
            box_v=1.01,   # 归一化包围盒略大于 1，避免贴边采样被裁掉
            mc_level=0.0, # marching cubes 等值面，0 为默认零交叉面
        )
    print(f'[test] inference done in {time.time() - t1:.1f}s', flush=True)
    if device == 'cuda':
        print(f'[test] peak VRAM: {torch.cuda.max_memory_allocated() / 1e9:.2f} GB',
              flush=True)

    # 结果结构：List[List[trimesh.Trimesh]]（批次 × 条目）
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
