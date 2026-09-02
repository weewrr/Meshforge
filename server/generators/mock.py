"""CPU relief-mesh generator used for development and demos (no GPU needed).

Turns the input image into a heightmap and extrudes it into a triangle mesh,
so the full pipeline (upload → job → mesh → GLB → viewer) can be exercised
before any real model is wired in.
"""

import threading
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

from .base import BaseGenerator, GenerationCancelled, ProgressFn


class MockReliefGenerator(BaseGenerator):
    id = 'mock-relief'
    display_name = 'Mock Relief (CPU)'
    input_type = 'image'
    output_type = 'mesh'
    params = [
        {'id': 'grid', 'label': '网格精度', 'type': 'int', 'default': 128, 'min': 32, 'max': 256},
        {'id': 'depth', 'label': '浮雕深度', 'type': 'float', 'default': 0.4, 'min': 0.05, 'max': 2.0},
    ]

    GRID = 128
    DEPTH = 0.4

    def generate(
        self,
        image_path: Path,
        out_dir: Path,
        params: dict,
        progress: ProgressFn,
        cancel: threading.Event,
    ) -> Path:
        grid = int(params.get('grid', self.GRID))
        depth = float(params.get('depth', self.DEPTH))

        progress(0.05, 'reading image')
        if cancel.is_set():
            raise GenerationCancelled
        img = Image.open(image_path).convert('L').resize((grid, grid), Image.BILINEAR)
        heights = np.asarray(img, dtype=np.float32) / 255.0

        progress(0.3, 'building vertices')
        if cancel.is_set():
            raise GenerationCancelled
        xs, ys = np.meshgrid(
            np.linspace(-1.0, 1.0, grid), np.linspace(-1.0, 1.0, grid)
        )
        vertices = np.stack(
            [xs.ravel(), -ys.ravel(), (heights.ravel() - 0.5) * depth], axis=1
        )

        progress(0.6, 'building faces')
        if cancel.is_set():
            raise GenerationCancelled
        idx = np.arange(grid * grid).reshape(grid, grid)
        a = idx[:-1, :-1].ravel()
        b = idx[:-1, 1:].ravel()
        c = idx[1:, 1:].ravel()
        d = idx[1:, :-1].ravel()
        faces = np.concatenate(
            [np.stack([a, b, c], axis=1), np.stack([a, c, d], axis=1)]
        )

        progress(0.85, 'exporting glb')
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / 'model.glb'
        mesh.export(out_path)

        progress(0.95, 'done')
        return out_path
