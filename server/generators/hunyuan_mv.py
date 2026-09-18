"""Hunyuan3D-2mv (multi-view) generator adapter.

Channel 2 — "manual four-view": MeshForge sends the 4 canonical view images
(front/left/back/right) to a Hunyuan3D-2mv inference service (dedicated port
8771) which returns a GLB. This is the only channel currently implemented.

Channel 1 — "single image -> auto four views" is RESERVED (not implemented):
Tencent ships no official single->MV model; it needs an external generative
image model (Era3D/Zero123++/...). Leave the marker below and wire it up later.
"""

import io
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .base import BaseGenerator, GenerationCancelled, ProgressFn
from .hunyuan import _probe

# 预留（通道 1）：单图 → 4 视图，由外部生成式模型完成。
# TODO(mv-auto)：在此接入视图生成模型，再把其输出 POST 到
# /generate-mv 端点。按设计决策暂不实现。
AUTO_VIEWS_CHANNEL_ENABLED = False


def _service_url() -> str:
    return os.environ.get(
        'MESHFORGE_HUNYUAN_MV_URL',
        os.environ.get('MESHFORGE_HUNYUAN_URL', 'http://127.0.0.1:8771'),
    ).rstrip('/')


def _multipart_views(url: str, view_paths: dict[str, Path], fields: dict) -> bytes:
    """Minimal multipart/form-data POST sending front/left/back/right files."""
    boundary = f'----meshforge-{uuid.uuid4().hex}'
    body = io.BytesIO()
    for key, value in fields.items():
        body.write(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'
            .encode())
    for tag, path in view_paths.items():
        body.write(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{tag}"; '
            f'filename="{path.name}"\r\nContent-Type: image/png\r\n\r\n'.encode())
        body.write(path.read_bytes())
        body.write(b'\r\n')
    body.write(f'--{boundary}--\r\n'.encode())
    req = Request(
        url,
        data=body.getvalue(),
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
        method='POST',
    )
    with urlopen(req, timeout=900) as resp:  # noqa: S310
        return resp.read()


from config import SERVICES_ROOT

_AUTOSTART_BASE = (str(SERVICES_ROOT / 'hy3dgen-venv' / 'Scripts' / 'python.exe'), str(SERVICES_ROOT / 'models'))
_SPAWN_LOCK = threading.Lock()
_spawned_proc: Optional['subprocess.Popen'] = None


def _autostart_config() -> Optional[dict]:
    """解析 Hunyuan3D-2mv 本地自动启动所需的 {python, model_root}。"""
    if os.environ.get('MESHFORGE_HUNYUAN_MV_AUTOSTART', '1') == '0':
        return None
    py = os.environ.get('MESHFORGE_HUNYUAN_MV_PY') or _AUTOSTART_BASE[0]
    root = os.environ.get('MESHFORGE_HUNYUAN_MV_MODEL_ROOT') or _AUTOSTART_BASE[1]
    if not Path(py).is_file():
        return None
    # 权重标记：<root>/tencent/Hunyuan3D-2mv/hunyuan3d-dit-v2-mv-turbo
    base = Path(root)
    mv = base / 'tencent' / 'Hunyuan3D-2mv'
    present = (mv / 'hunyuan3d-dit-v2-mv-turbo').is_dir() or (mv / 'hunyuan3d-dit-v2-mv').is_dir()
    if not present:
        return None
    return {'python': py, 'model_root': base}


def _ensure_service(url: str, subfolder: str, progress: Optional[ProgressFn]) -> bool:
    """自动拉起 Hunyuan3D-2mv 推理服务；一旦 /health 应答即返回 `True`。"""
    global _spawned_proc
    if _probe(url):
        return True
    from urllib.parse import urlsplit
    host = urlsplit(url).hostname or '127.0.0.1'
    if host not in ('127.0.0.1', 'localhost'):
        return False
    port = urlsplit(url).port or 8771
    cfg = _autostart_config()
    if cfg is None:
        return False
    with _SPAWN_LOCK:
        if _probe(url):
            return True
        if progress:
            progress(0.02, f'starting Hunyuan3D-2mv ({subfolder}) service on :{port} …')
        server_root = Path(__file__).resolve().parent.parent
        script = server_root / 'hunyuan_service.py'
        log_path = server_root / 'workspace' / 'logs' / f'hunyuan-mv-{port}.log'
        log_path.parent.mkdir(parents=True, exist_ok=True)
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        spawn_env = {**os.environ, 'HY3DGEN_SUBFOLDER': subfolder}
        with log_path.open('ab') as log:
            _spawned_proc = subprocess.Popen(
                [
                    cfg['python'], str(script),
                    '--model-root', str(cfg['model_root']),
                    '--model', 'Hunyuan3D-2mv',
                    '--offload', os.environ.get('HY3DGEN_OFFLOAD', 'none'),
                    '--host', '127.0.0.1', '--port', str(port),
                    '--preload',
                ],
                env=spawn_env,
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if _probe(url):
                return True
            if _spawned_proc.poll() is not None:
                return False
            time.sleep(0.5)
        return _probe(url)


class Hunyuan3DMVGenerator(BaseGenerator):
    id = 'hunyuan3d-2-mv'
    display_name = 'Hunyuan3D 2 MV (4视图, Real)'
    input_type = 'image'   # channel 2 currently takes 4 files (front/left/back/right)
    output_type = 'mesh'
    params = [
        {'id': 'steps', 'label': '采样步数', 'type': 'int', 'default': 20, 'min': 5, 'max': 100,
         'tooltip': 'turbo 版建议 8~20'},
        {'id': 'octree', 'label': '重建分辨率', 'type': 'select', 'default': 256,
         'options': [
             {'value': 256, 'label': '标准 256（省显存）'},
             {'value': 320, 'label': '精细 320（推荐）'},
             {'value': 384, 'label': '最高 384（低显存有 OOM 风险）'},
         ],
         'tooltip': '体积重建分辨率：越高表面细节越丰富，显存与耗时随之增加'},
        {'id': 'seed', 'label': '随机种子', 'type': 'int', 'default': -1, 'min': -1, 'max': 999_999_999},
        {'id': 'remove_base', 'label': '去底部圆盘', 'type': 'select', 'default': 1,
         'options': [
             {'value': 1, 'label': '开启（推荐）'},
             {'value': 0, 'label': '关闭（保留底座）'},
         ]},
        # 四视角外部映射：指明上游数组节点的哪一项充当各视角（默认顺序 0/1/2/3）。
        # 数组内恰好按 front/left/back/right 顺序放 4 张图时无需改动；顺序不同才需调整。
        {'id': 'view_front_index', 'label': 'Front 视角=第几张', 'type': 'int', 'default': 0, 'min': 0},
        {'id': 'view_left_index', 'label': 'Left 视角=第几张', 'type': 'int', 'default': 1, 'min': 0},
        {'id': 'view_back_index', 'label': 'Back 视角=第几张', 'type': 'int', 'default': 2, 'min': 0},
        {'id': 'view_right_index', 'label': 'Right 视角=第几张', 'type': 'int', 'default': 3, 'min': 0},
    ]

    def __init__(
        self,
        *,
        port: int = 8771,
        subfolder: str = 'hunyuan3d-dit-v2-mv-turbo',
        gen_id: str = 'hunyuan3d-2-mv',
        name: str = 'Hunyuan3D 2 MV (4视图, Real)',
    ) -> None:
        super().__init__()
        self.id = gen_id
        self.display_name = name
        self.port = port
        self.subfolder = subfolder
        self._url = (
            os.environ.get('MESHFORGE_HUNYUAN_MV_URL')
            or os.environ.get('MESHFORGE_HUNYUAN_URL')
            or f'http://127.0.0.1:{port}'
        ).rstrip('/')

    def load(self, progress: Optional[ProgressFn] = None) -> None:
        ok = _probe(self._url)
        if not ok:
            ok = _ensure_service(self._url, self.subfolder, progress)
        self._loaded = ok
        if progress:
            progress(1.0, 'Hunyuan3D-2mv reachable' if ok else 'Hunyuan3D-2mv NOT reachable')
        if not ok:
            raise RuntimeError(
                f'Hunyuan3D-2mv（{self.subfolder}）服务不可达（{self._url}）且自动启动失败 — '
                f'请确认权重已下载到 D:/github/models/Hunyuan3D-2mv/（{self.subfolder}），'
                f'查看 workspace/logs/hunyuan-mv-{self.port}.log，或手动启动：'
                f'hy3dgen venv 运行 server/hunyuan_service.py --model Hunyuan3D-2mv '
                f'(设置 HY3DGEN_SUBFOLDER={self.subfolder}) --model-root <权重目录> --port {self.port}'
            )

    def generate(
        self,
        image_path: Path,
        out_dir: Path,
        params: dict,
        progress: ProgressFn,
        cancel: threading.Event,
    ) -> Path:
        """四视角输入：期望 front/left/back/right 四张图随 `image_path` 一起就绪。

        MeshForge 只给本适配器一个 `image_path`；四视角变体需要另外三张兄弟图。
        调用方通过额外 params（view_front/view_left/view_back/view_right 路径）把
        其余视角一并带上，从而用四字段上传驱动推理。若任一视角缺失则报错。

        Args:
            image_path: 占位用的输入图片路径（四视角实际取自 params）。
            out_dir: `.glb` 输出目录。
            params: 含四视角路径与采样步数/重建分辨率/种子/去底座等参数。
            progress: 进度回调（上传 / 接收 / 完成三段）。
            cancel: 取消事件，上传前与接收前各轮询一次。

        Returns:
            生成的 `model.glb` 路径。
        """
        if not self._loaded:
            self.load(progress)

        views = {
            'front': params.get('view_front'),
            'left': params.get('view_left'),
            'back': params.get('view_back'),
            'right': params.get('view_right'),
        }
        missing = [tag for tag, p in views.items() if not p or not Path(p).is_file()]
        if missing:
            raise RuntimeError(
                f'Hunyuan3D-2mv 需要 4 个视角文件 front/left/back/right，缺少: {", ".join(missing)}。'
                '（单图自动出四图渠道尚未启用）'
            )

        progress(0.15, 'uploading 4 views')
        if cancel.is_set():
            raise GenerationCancelled
        try:
            payload = _multipart_views(
                f'{self._url}/generate-mv',
                {tag: Path(p) for tag, p in views.items()},  # type: ignore[arg-type]
                {
                    'steps': str(int(params.get('steps', 20))),
                    'octree': str(int(params.get('octree', 256))),
                    'seed': str(int(params.get('seed', -1))),
                    'remove_base': str(1 if int(params.get('remove_base', 1)) != 0 else 0),
                },
            )
        except (URLError, HTTPError, OSError) as exc:
            raise RuntimeError(f'Hunyuan3D-2mv 调用失败: {exc}') from exc

        progress(0.7, 'receiving mesh')
        if cancel.is_set():
            raise GenerationCancelled
        if not payload:
            raise RuntimeError('Hunyuan3D-2mv 返回空响应')

        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / 'model.glb'
        out_path.write_bytes(payload)
        progress(1.0, 'done')
        return out_path