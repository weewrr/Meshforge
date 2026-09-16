"""Hunyuan3D-2-mini generator adapter.

Wire-in point for the real model: points at a local inference service
(recommended: a Hunyuan3D server or ComfyUI exposing an HTTP API) via the
MESHFORGE_HUNYUAN_URL env var. Loading probes the service; generation POSTs
the input image and saves the returned GLB.

If the service is not reachable, load() first tries to auto-start the bundled
server/hunyuan_service.py inside the hy3dgen virtualenv (resolved via the
MESHFORGE_HUNYUAN_PY / MESHFORGE_HUNYUAN_MODEL_ROOT env vars, falling back to
the default install location; set MESHFORGE_HUNYUAN_AUTOSTART=0 to disable).
Only when auto-start also fails does load() raise — mock-relief remains the
working default for development.
"""

import io
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .base import BaseGenerator, GenerationCancelled, ProgressFn


def _service_url() -> str:
    import os
    # Default matches server/hunyuan_service.py (--port 8767). Set
    # MESHFORGE_HUNYUAN_URL to point at a different inference endpoint.
    return os.environ.get('MESHFORGE_HUNYUAN_URL', 'http://127.0.0.1:8767').rstrip('/')


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


# ─── Local inference-service auto-start ──────────────────────────────────────
# hunyuan_service.py must run inside the hy3dgen virtualenv — a different
# interpreter than this server's. Instead of requiring a manual launch, load()
# starts it as a child process when the health probe fails and a local install
# is discoverable. The child is detached enough to outlive single jobs; its
# stdout/stderr go to workspace/logs/hunyuan-service.log.

_AUTOSTART_CANDIDATES = [
    (r'D:\github\hy3dgen-venv\Scripts\python.exe', r'D:\github\models'),
    (r'C:\github\hy3dgen-venv\Scripts\python.exe', r'C:\github\models'),
]

_SPAWN_LOCK = threading.Lock()
_spawned_proc: Optional['subprocess.Popen'] = None


def _probe(url: str) -> bool:
    try:
        with urlopen(f'{url}/health', timeout=3) as resp:  # noqa: S310
            return resp.status == 200
    except (URLError, HTTPError, OSError):
        return False


def _autostart_config() -> Optional[dict]:
    """Resolve {python, model_root} for a local auto-start, or None."""
    if os.environ.get('MESHFORGE_HUNYUAN_AUTOSTART', '1') == '0':
        return None

    custom_py = os.environ.get('MESHFORGE_HUNYUAN_PY')
    custom_root = os.environ.get('MESHFORGE_HUNYUAN_MODEL_ROOT')
    pys = ([custom_py] if custom_py else []) + (
        [c[0] for c in _AUTOSTART_CANDIDATES] if sys.platform == 'win32' else []
    )
    roots = ([custom_root] if custom_root else []) + (
        [c[1] for c in _AUTOSTART_CANDIDATES] if sys.platform == 'win32' else []
    )
    for py in pys:
        if not Path(py).is_file():
            continue
        for root in roots:
            if (Path(root) / 'Hunyuan3D-2mini').is_dir():
                return {'python': py, 'model_root': root}
    return None


def _ensure_service(url: str, progress: Optional[ProgressFn]) -> bool:
    """Auto-start the local inference service; True once /health responds."""
    global _spawned_proc

    if _probe(url):
        return True

    from urllib.parse import urlsplit

    host = urlsplit(url).hostname or '127.0.0.1'
    if host not in ('127.0.0.1', 'localhost'):
        return False  # remote endpoint — never spawn a local process for it
    port = urlsplit(url).port or 8767

    cfg = _autostart_config()
    if cfg is None:
        return False

    with _SPAWN_LOCK:
        if _probe(url):  # a concurrent load() started it while we waited
            return True

        if progress:
            progress(0.02, f'starting Hunyuan3D inference service on :{port} …')
        server_root = Path(__file__).resolve().parent.parent
        script = server_root / 'hunyuan_service.py'
        log_path = server_root / 'workspace' / 'logs' / 'hunyuan-service.log'
        log_path.parent.mkdir(parents=True, exist_ok=True)
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        with log_path.open('ab') as log:
            _spawned_proc = subprocess.Popen(
                [
                    cfg['python'], str(script),
                    '--model-root', cfg['model_root'],
                    '--host', '127.0.0.1', '--port', str(port),
                    '--preload',
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )

        # Wait for uvicorn to answer /health. The model keeps preloading in
        # the background; /generate blocks on the pipeline until it is ready.
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if _probe(url):
                return True
            if _spawned_proc.poll() is not None:
                return False  # process exited — see hunyuan-service.log
            time.sleep(0.5)
        return _probe(url)


class Hunyuan3DGenerator(BaseGenerator):
    id = 'hunyuan3d-2-mini'
    display_name = 'Hunyuan3D 2 mini (Real)'
    input_type = 'image'
    output_type = 'mesh'
    params = [
        {'id': 'steps', 'label': '采样步数', 'type': 'int', 'default': 20, 'min': 5, 'max': 100},
        {'id': 'guidance', 'label': '引导强度', 'type': 'float', 'default': 4.0, 'min': 1.0, 'max': 10.0},
        {'id': 'octree', 'label': '重建分辨率', 'type': 'select', 'default': 256,
         'options': [
             {'value': 256, 'label': '标准 256（省显存）'},
             {'value': 320, 'label': '精细 320（推荐）'},
             {'value': 384, 'label': '最高 384（细节最佳，6GB 显存有 OOM 风险）'},
         ],
         'tooltip': '体积重建分辨率：越高表面细节越丰富，显存与耗时随之增加'},
        {'id': 'seed', 'label': '随机种子', 'type': 'int', 'default': -1, 'min': -1, 'max': 999_999_999,
         'tooltip': '-1 = 每次随机；固定为某个正数可复现同一结果，换种子多试几次挑最佳'},
        {'id': 'remove_base', 'label': '去底部圆盘', 'type': 'select', 'default': 1,
         'options': [
             {'value': 1, 'label': '开启（推荐）'},
             {'value': 0, 'label': '关闭（保留底座）'},
         ],
         'tooltip': '自动检测并移除模型底部由地面阴影产生的支撑圆盘（保留真实底座设计时选关闭）'},
    ]

    def __init__(self) -> None:
        super().__init__()
        self._url = _service_url()

    def load(self, progress: Optional[ProgressFn] = None) -> None:
        """Probe the inference service health endpoint, auto-starting it if down."""
        ok = _probe(self._url)
        if not ok:
            ok = _ensure_service(self._url, progress)
        self._loaded = ok
        if progress:
            progress(1.0, 'Hunyuan3D service reachable' if ok else 'Hunyuan3D service NOT reachable')
        if not ok:
            raise RuntimeError(
                f'Hunyuan3D 服务不可达（{self._url}）且自动启动失败 — '
                '请检查 workspace/logs/hunyuan-service.log，或手动启动推理服务'
                '（hy3dgen venv 运行 server/hunyuan_service.py --model-root <权重目录> --port 8767），'
                '或通过 MESHFORGE_HUNYUAN_PY / MESHFORGE_HUNYUAN_MODEL_ROOT 指定安装位置，'
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
                {
                    'steps': str(int(params.get('steps', 20))),
                    'guidance': str(float(params.get('guidance', 4.0))),
                    'octree': str(int(params.get('octree', 256))),
                    'seed': str(int(params.get('seed', -1))),
                    'remove_base': str(1 if int(params.get('remove_base', 1)) != 0 else 0),
                },
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
