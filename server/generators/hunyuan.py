"""Hunyuan3D-2-mini generator adapter.

Wire-in point for the real model: points at a local inference service
(recommended: a Hunyuan3D server or ComfyUI exposing an HTTP API) via the
MESHFORGE_HUNYUAN_URL env var. Loading probes the service; generation POSTs
the input image and saves the returned GLB.

If the service is not reachable the generator reports is_loaded=False and the
frontend shows it as available-but-unloaded (mock-relief remains the working
default for development).
"""

import io
import threading
import uuid
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .base import BaseGenerator, GenerationCancelled, ProgressFn


def _service_url() -> str:
    import os
    return os.environ.get('MESHFORGE_HUNYUAN_URL', 'http://127.0.0.1:8000').rstrip('/')


def _multipart_post(url: str, image_path: Path, fields: dict) -> bytes:
    """Minimal multipart/form-data POST using only the standard library."""
    boundary = f'----meshforge-{uuid.uuid4().hex}'
    body = io.BytesIO()

    for key, value in fields.items():
        body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())

    name = image_path.name
    body.write(
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\n'.encode()
        + b'Content-Type: image/png\r\n\r\n'
    )
    body.write(image_path.read_bytes())
    body.write(f'\r\n--{boundary}--\r\n'.encode())

    req = Request(
        url,
        data=body.getvalue(),
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
        method='POST',
    )
    with urlopen(req, timeout=600) as resp:  # noqa: S310
        return resp.read()


class Hunyuan3DGenerator(BaseGenerator):
    id = 'hunyuan3d-2-mini'
    display_name = 'Hunyuan3D 2 mini (Real)'
    input_type = 'image'
    output_type = 'mesh'
    params = [
        {'id': 'steps', 'label': '采样步数', 'type': 'int', 'default': 20, 'min': 5, 'max': 100},
        {'id': 'guidance', 'label': '引导强度', 'type': 'float', 'default': 4.0, 'min': 1.0, 'max': 10.0},
    ]

    def __init__(self) -> None:
        super().__init__()
        self._url = _service_url()

    def load(self, progress: Optional[ProgressFn] = None) -> None:
        """Probe the inference service health endpoint."""
        try:
            with urlopen(f'{self._url}/health', timeout=3) as resp:  # noqa: S310
                ok = resp.status == 200
        except (URLError, HTTPError, OSError):
            ok = False
        self._loaded = ok
        if progress:
            progress(1.0, 'Hunyuan3D service reachable' if ok else 'Hunyuan3D service NOT reachable')
        if not ok:
            raise RuntimeError(
                f'Hunyuan3D 服务不可达（{self._url}）— 请启动推理服务并设置 MESHFORGE_HUNYUAN_URL，'
                '或改用 mock-relief'
            )

    def generate(
        self,
        image_path: Path,
        out_dir: Path,
        params: dict,
        progress: ProgressFn,
        cancel: threading.Event,
    ) -> Path:
        if not self._loaded:
            self.load(progress)

        progress(0.15, 'uploading image')
        if cancel.is_set():
            raise GenerationCancelled
        try:
            payload = _multipart_post(
                f'{self._url}/generate',
                image_path,
                {'steps': str(int(params.get('steps', 20))), 'guidance': str(float(params.get('guidance', 4.0)))},
            )
        except (URLError, HTTPError, OSError) as exc:
            raise RuntimeError(f'Hunyuan3D 调用失败: {exc}') from exc

        progress(0.7, 'receiving mesh')
        if cancel.is_set():
            raise GenerationCancelled
        if not payload:
            raise RuntimeError('Hunyuan3D 返回空响应')

        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / 'model.glb'
        out_path.write_bytes(payload)
        progress(1.0, 'done')
        return out_path
