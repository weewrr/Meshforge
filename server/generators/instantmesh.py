"""InstantMesh generator adapter (Tencent InstantMesh, single image → mesh).

Points at the local inference service ``server/instantmesh_service.py`` running
inside the *instantmesh* virtualenv. Two variants are exposed:

  * instantmesh     — configs/instant-mesh-large.yaml，端口 8770（默认；
                      ~11 GB VRAM)
  * instantmesh-base — configs/instant-mesh-base.yaml，端口 8777（低显存；
                      still needs ~>=8 GB)

InstantMesh generates 6 multiview images with Zero123++ then reconstructs a
mesh (flexicubes LRM), exporting an ``.obj`` that the service converts to GLB.
There is no official low-VRAM switch — on 6 GB GPUs the reconstruction stage
OOMs. Set MESHFORGE_INSTANTMESH_URL to point elsewhere, and
MESHFORGE_INSTANTMESH_AUTOSTART=0 to disable auto-launch.
"""

import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

from .base import BaseGenerator, GenerationCancelled, ProgressFn
from .hunyuan import _multipart_post, _probe

from config import SERVICES_ROOT

_AUTOSTART_BASE = (
    str(SERVICES_ROOT / 'instantmesh-venv' / 'Scripts' / 'python.exe'),
    str(SERVICES_ROOT / 'models'),
    str(SERVICES_ROOT / 'InstantMesh'),
)
_SPAWN_LOCK = threading.Lock()
_spawned_proc: Optional['subprocess.Popen'] = None


def _autostart_config() -> Optional[dict]:
    if os.environ.get('MESHFORGE_INSTANTMESH_AUTOSTART', '1') == '0':
        return None
    py = os.environ.get('MESHFORGE_INSTANTMESH_PY') or _AUTOSTART_BASE[0]
    root = os.environ.get('MESHFORGE_INSTANTMESH_MODEL_ROOT') or _AUTOSTART_BASE[1]
    repo = os.environ.get('MESHFORGE_INSTANTMESH_REPO') or _AUTOSTART_BASE[2]
    if not Path(py).is_file():
        return None
    if not (Path(root) / 'InstantMesh' / 'diffusion_pytorch_model.bin').is_file():
        return None
    if not (Path(repo) / 'run.py').is_file():
        return None
    return {'python': py, 'model_root': Path(root), 'repo': Path(repo)}


def _ensure_service(url: str, config: str, progress: Optional[ProgressFn]) -> bool:
    """Auto-start the InstantMesh inference service; True once /health answers."""
    global _spawned_proc
    if _probe(url):
        return True

    from urllib.parse import urlsplit

    host = urlsplit(url).hostname or '127.0.0.1'
    if host not in ('127.0.0.1', 'localhost'):
        return False
    port = urlsplit(url).port or 8770

    cfg = _autostart_config()
    if cfg is None:
        return False

    with _SPAWN_LOCK:
        if _probe(url):
            return True
        if progress:
            progress(0.02, f'starting InstantMesh service on :{port} …')
        server_root = Path(__file__).resolve().parent.parent
        script = server_root / 'instantmesh_service.py'
        log_path = server_root / 'workspace' / 'logs' / f'instantmesh-{port}.log'
        log_path.parent.mkdir(parents=True, exist_ok=True)
        # Windows 下 CREATE_NO_WINDOW 避免推理服务弹出控制台黑窗；其它平台无此标志。
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        with log_path.open('ab') as log:
            _spawned_proc = subprocess.Popen(
                [
                    str(cfg['python']), str(script),
                    '--model-root', str(cfg['model_root']),
                    '--repo', str(cfg['repo']),
                    '--config', config,
                    '--host', '127.0.0.1', '--port', str(port),
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if _probe(url):
                return True
            if _spawned_proc.poll() is not None:
                return False
            time.sleep(0.5)
        return _probe(url)


class InstantMeshGenerator(BaseGenerator):
    id = 'instantmesh'
    display_name = 'InstantMesh 大档 (Real)'
    input_type = 'image'
    output_type = 'mesh'
    params = [
        {'id': 'diffusion_steps', 'label': '扩散采样步数', 'type': 'int', 'default': 30,
         'min': 5, 'max': 100,
         'tooltip': 'Zero123++ 多视图采样步数：官方默认 75，增大更细腻但更慢'},
        {'id': 'seed', 'label': '随机种子', 'type': 'int', 'default': 42, 'min': 0, 'max': 999_999_999,
         'tooltip': '固定为正数可复现同一结果；换种子多试几次挑最佳'},
        {'id': 'export_texmap', 'label': '导出纹理贴图', 'type': 'select', 'default': 0,
         'options': [
             {'value': 1, 'label': '开启（含 UV 纹理）'},
             {'value': 0, 'label': '关闭（仅顶点色，更快省内存）'},
         ],
         'tooltip': '导出带 UV 纹理贴图的网格（默认仅顶点颜色）'},
        {'id': 'rembg', 'label': '前景抠图', 'type': 'select', 'default': 0,
         'options': [
             {'value': 0, 'label': '关闭（默认，避免联网下载 u2net）'},
             {'value': 1, 'label': '开启（需 rembg 权重可下载）'},
         ],
         'tooltip': '开启会调用 rembg 去除输入背景（需能下载 u2net 权重），关闭则直接使用原图'},
        {'id': 'vram_note', 'label': '显存', 'type': 'label', 'default': '需 ≥10GB 显存；6GB(RTX4050) 重建阶段会 OOM，请用 InstantMesh 低显存档'},
    ]

    def __init__(self, *, port: int = 8770, config: str = 'configs/instant-mesh-large.yaml',
                 gen_id: str = 'instantmesh', name: str = 'InstantMesh 大档 (Real)') -> None:
        super().__init__()
        self.id = gen_id
        self.display_name = name
        self.port = port
        self.config = config
        self._url = (
            os.environ.get('MESHFORGE_INSTANTMESH_URL')
            or f'http://127.0.0.1:{port}'
        ).rstrip('/')

    def load(self, progress: Optional[ProgressFn] = None) -> None:
        ok = _probe(self._url)
        if not ok:
            ok = _ensure_service(self._url, self.config, progress)
        self._loaded = ok
        if progress:
            progress(1.0, 'InstantMesh reachable' if ok else 'InstantMesh NOT reachable')
        if not ok:
            raise RuntimeError(
                f'InstantMesh 服务不可达（{self._url}）且自动启动失败 — '
                f'请先下载权重到 D:/github/models/InstantMesh/（diffusion_pytorch_model.bin + '
                f'{self.config.split("/")[-1].replace("-", "_")}），并完成环境搭建 '
                f'（含 nvdiffrast 编译，需 CUDA Toolkit；见 README 部署章节）；'
                f'查看 workspace/logs/instantmesh-{self.port}.log'
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
                    'seed': str(int(params.get('seed', 42))),
                    'diffusion_steps': str(int(params.get('diffusion_steps', 30))),
                    'export_texmap': str(1 if int(params.get('export_texmap', 0)) != 0 else 0),
                    'rembg': str(1 if int(params.get('rembg', 0)) != 0 else 0),
                },
            )
        except (OSError,) as exc:  # urllib 的 HTTPError/URLError 都是 OSError 子类
            raise RuntimeError(f'InstantMesh 调用失败: {exc}') from exc

        progress(0.7, 'receiving mesh')
        if cancel.is_set():
            raise GenerationCancelled
        if not payload:
            raise RuntimeError('InstantMesh 返回空响应')

        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / 'model.glb'
        out_path.write_bytes(payload)
        progress(1.0, 'done')
        return out_path