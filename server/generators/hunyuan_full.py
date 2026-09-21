"""Hunyuan3D-2 full generator adapter.

Points at the same local inference service as the mini variant
(``server/hunyuan_service.py``) but on a dedicated port (8768) running the
full ``Hunyuan3D-2`` weights (default turbo subfolder). Set
``MESHFORGE_HUNYUAN_URL``/``MESHFORGE_HUNYUAN_FULL_URL`` to override, port 8768
by default. Enable CPU offload on the service with ``HY3DGEN_OFFLOAD=model``
(low-VRAM) or run purely on CPU with ``--device cpu`` (slow, no GPU needed).
"""

import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError

from .base import BaseGenerator, GenerationCancelled, ProgressFn
from .hunyuan import _multipart_post, _probe


def _service_url() -> str:
    """返回完整版推理服务的基址（优先 FULL_URL，回退通用 URL，默认 8768）。"""
    return os.environ.get(
        'MESHFORGE_HUNYUAN_FULL_URL',
        os.environ.get('MESHFORGE_HUNYUAN_URL', 'http://127.0.0.1:8768'),
    ).rstrip('/')


# 自动启动候选复用 hy3dgen venv，但仅在完整权重存在时生效
# （SERVICES_ROOT/models/Hunyuan3D-2/...）。可用 MESHFORGE_HUNYUAN_FULL_PY /
# MESHFORGE_HUNYUAN_FULL_MODEL_ROOT 覆盖。
from config import SERVICES_ROOT

_AUTOSTART_BASE = (str(SERVICES_ROOT / 'hy3dgen-venv' / 'Scripts' / 'python.exe'), str(SERVICES_ROOT / 'models'))
_SPAWN_LOCK = threading.Lock()
_spawned_proc: Optional['subprocess.Popen'] = None


def _autostart_config() -> Optional[dict]:
    if os.environ.get('MESHFORGE_HUNYUAN_FULL_AUTOSTART', '1') == '0':
        return None
    py = os.environ.get('MESHFORGE_HUNYUAN_FULL_PY') or _AUTOSTART_BASE[0]
    root = os.environ.get('MESHFORGE_HUNYUAN_FULL_MODEL_ROOT') or _AUTOSTART_BASE[1]
    if not Path(py).is_file():
        return None
    # marker 检查同时接受 Hunyuan3D-2/ 与 Hunyuan3D-2/dit-* 两种布局
    base = Path(root)
    full = base / 'Hunyuan3D-2'
    present = (full / 'hunyuan3d-dit-v2-0').is_dir() or (
        full / 'hunyuan3d-dit-v2-0-turbo').is_dir()
    if not present:
        return None
    return {'python': py, 'model_root': base, 'full_root': full}


def _ensure_service(url: str, subfolder: str, progress: Optional[ProgressFn]) -> bool:
    """自动拉起完整版推理服务；一旦 /health 应答即返回 `True`。"""
    global _spawned_proc
    if _probe(url):
        return True

    from urllib.parse import urlsplit

    host = urlsplit(url).hostname or '127.0.0.1'
    if host not in ('127.0.0.1', 'localhost'):
        return False
    port = urlsplit(url).port or 8768

    cfg = _autostart_config()
    if cfg is None:
        return False

    with _SPAWN_LOCK:
        if _probe(url):
            return True
        if progress:
            progress(0.02, f'starting Hunyuan3D-2 ({subfolder}) service on :{port} …')
        server_root = Path(__file__).resolve().parent.parent
        script = server_root / 'hunyuan_service.py'
        log_path = server_root / 'workspace' / 'logs' / f'hunyuan-full-{port}.log'
        log_path.parent.mkdir(parents=True, exist_ok=True)
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        spawn_env = {**os.environ, 'HY3DGEN_SUBFOLDER': subfolder}
        with log_path.open('ab') as log:
            _spawned_proc = subprocess.Popen(
                [
                    cfg['python'], str(script),
                    '--model-root', str(cfg['model_root']),
                    '--model', 'Hunyuan3D-2',
                    '--offload', os.environ.get('HY3DGEN_OFFLOAD', 'none'),
                    '--host', '127.0.0.1', '--port', str(port),
                    '--preload',
                ],
                env=spawn_env,
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


class Hunyuan3DFullGenerator(BaseGenerator):
    id = 'hunyuan3d-2'
    display_name = 'Hunyuan3D 2 Full (Real)'
    input_type = 'image'
    output_type = 'mesh'
    # 数字参数一律 pin_only（同 hunyuan.py 的说明）：节点上不摆输入框，改值走引脚；
    # 下拉框保留控件，因为"选项"本身就是信息。
    params = [
        {'id': 'steps', 'label': '采样步数', 'type': 'int', 'default': 20, 'min': 5, 'max': 100,
         'pin_only': True,
         'tooltip': '默认 turbo 版建议 8~20；标准版建议 50（需以 HY3DGEN_SUBFOLDER=hunyuan3d-dit-v2-0 启动服务）'},
        {'id': 'guidance', 'label': '引导强度', 'type': 'float', 'default': 5.0, 'min': 1.0, 'max': 10.0,
         'pin_only': True,
         'tooltip': 'CFG 引导强度：越大越贴合输入图，过高可能过饱和'},
        {'id': 'octree', 'label': '重建分辨率', 'type': 'select', 'default': 256,
         'options': [
             {'value': 256, 'label': '标准 256（省显存）'},
             {'value': 320, 'label': '精细 320（推荐）'},
             {'value': 384, 'label': '最高 384（低显存有 OOM 风险）'},
         ],
         'tooltip': '体积重建分辨率：越高表面细节越丰富，显存与耗时随之增加'},
        {'id': 'seed', 'label': '随机种子', 'type': 'int', 'default': -1, 'min': -1, 'max': 999_999_999,
         'pin_only': True,
         'tooltip': '-1 = 每次随机；固定为某个正数可复现同一结果，换种子多试几次挑最佳'},
        {'id': 'remove_base', 'label': '去底部圆盘', 'type': 'select', 'default': 1,
         'options': [
             {'value': 1, 'label': '开启（推荐）'},
             {'value': 0, 'label': '关闭（保留底座）'},
         ],
         'tooltip': '自动检测并移除模型底部由地面阴影产生的支撑圆盘（保留真实底座设计时选关闭）'},
    ]

    def __init__(
        self,
        *,
        port: int = 8768,
        subfolder: str = 'hunyuan3d-dit-v2-0-turbo',
        gen_id: str = 'hunyuan3d-2',
        name: str = 'Hunyuan3D 2 Full (Real)',
    ) -> None:
        """同进程内可注册多个完整版实例（turbo / 标准），靠 port 与 subfolder 区分。"""
        super().__init__()
        self.id = gen_id
        self.display_name = name
        self.port = port
        self.subfolder = subfolder
        self._url = (
            os.environ.get('MESHFORGE_HUNYUAN_FULL_URL')
            or os.environ.get('MESHFORGE_HUNYUAN_URL')
            or f'http://127.0.0.1:{port}'
        ).rstrip('/')
        self._model_dir: Optional[Path] = None

    def load(self, progress: Optional[ProgressFn] = None) -> None:
        """探针完整版推理服务；不可达则按 subfolder 自动拉起，仍失败抛错。"""
        ok = _probe(self._url)
        if not ok:
            ok = _ensure_service(self._url, self.subfolder, progress)
        self._loaded = ok
        if progress:
            progress(1.0, 'Hunyuan3D-2 full reachable' if ok else 'Hunyuan3D-2 full NOT reachable')
        if not ok:
            raise RuntimeError(
                f'Hunyuan3D-2 full（{self.subfolder}）服务不可达（{self._url}）且自动启动失败 — '
                f'请先下载权重（modelscope: Tencent-Hunyuan/Hunyuan3D-2 → {self.subfolder}/*，'
                f'落盘 D:/github/models/Hunyuan3D-2/），查看 workspace/logs/hunyuan-full-{self.port}.log，'
                f'或手动启动：hy3dgen venv 运行 server/hunyuan_service.py --model Hunyuan3D-2 '
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
        """把输入图片 POST 给完整版推理服务，接收返回的 GLB 并落盘。

        Args:
            image_path: 输入图片路径。
            out_dir: `.glb` 输出目录。
            params: 前端下发的采样步数/引导强度/重建分辨率/种子/去底座等参数。
            progress: 进度回调（上传 / 接收 / 完成三段）。
            cancel: 取消事件，上传前与接收前各轮询一次。

        Returns:
            生成的 `model.glb` 路径。
        """
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
                    'guidance': str(float(params.get('guidance', 5.0))),
                    'octree': str(int(params.get('octree', 256))),
                    'seed': str(int(params.get('seed', -1))),
                    'remove_base': str(1 if int(params.get('remove_base', 1)) != 0 else 0),
                },
            )
        except (URLError, HTTPError, OSError) as exc:
            raise RuntimeError(f'Hunyuan3D-2 调用失败: {exc}') from exc

        progress(0.7, 'receiving mesh')
        if cancel.is_set():
            raise GenerationCancelled
        if not payload:
            raise RuntimeError('Hunyuan3D-2 返回空响应')

        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / 'model.glb'
        out_path.write_bytes(payload)
        progress(1.0, 'done')
        return out_path