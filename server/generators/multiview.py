"""单图 → 多视图图 生成适配器（生视图模型，与「图→网格」生成建模模型区分）。

与 hunyuan_full / instantmesh 的 mesh 适配器不同，这类模型输出的是**多视图
拼图（PNG）**而不是网格，因此：

  * ``category = 'multiview'`` —— describe_all() / /extensions 据此把生视图模型
    与 ``category='mesh'`` 的生成建模模型分开展示；
  * ``output_type = 'image'`` —— 产物为多视图图片，由独立推理服务
    ``<id>_service.py`` 返回 PNG 字节，适配器写入 out_dir/<id>.png 并返回。

每个生视图模型跑在各自专属 venv（镜像 MESHFORGE_HUNYUAN_* / INSTANTMESH_* 的
自动拉起模式：查 venv 解释器 + 权重 marker 文件，缺一即不自动启动并在 load()
给出中文提示）。环境变量覆盖：

  MESHFORGE_<NAME>_URL / MESHFORGE_<NAME>_PY / MESHFORGE_<NAME>_MODEL_ROOT
  MESHFORGE_<NAME>_AUTOSTART=0  关闭自动拉起
（<NAME> 见下方各实例的 _ENV 前缀，如 MVDREAM / ZERO123 / WONDER3D）
"""

import os
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional
from urllib.request import Request, urlopen

from .base import BaseGenerator, GenerationCancelled, ProgressFn
from .hunyuan import _multipart_post, _probe
from config import SERVICES_ROOT


def _multipart_post_text(url: str, fields: dict[str, str]) -> bytes:
    """纯文本字段的 multipart POST（MVDream 之类 text→多视图模型的 /generate）。

    与 hunyuan._multipart_post 同构，但 body 只有 Form 字段、无文件。
    """
    boundary = '----MesForge' + uuid.uuid4().hex
    body = bytearray()
    for key, value in fields.items():
        body += f'--{boundary}\r\n'.encode()
        body += f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode()
        body += f'{value}\r\n'.encode()
    body += f'--{boundary}--\r\n'.encode()
    req = Request(
        url,
        data=bytes(body),
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
        method='POST',
    )
    with urlopen(req, timeout=600) as resp:
        return resp.read()

_SPAWN_LOCK = threading.Lock()
_spawned_procs: list['subprocess.Popen'] = []


def _ensure_service(url: str, autostart: dict, progress: Optional[ProgressFn]) -> bool:
    """自动拉起某个生视图模型的推理服务；/health 有应答即成功。"""
    if _probe(url):
        return True

    from urllib.parse import urlsplit

    host = urlsplit(url).hostname or '127.0.0.1'
    if host not in ('127.0.0.1', 'localhost'):
        return False
    port = urlsplit(url).port or 8780

    py = autostart.get('python')
    marker = autostart.get('marker')
    if not py or not Path(py).is_file():
        return False
    if marker and not Path(marker).is_file():
        return False

    with _SPAWN_LOCK:
        if _probe(url):
            return True
        if progress:
            progress(0.02, f'starting {autostart["name"]} service on :{port} …')
        server_root = Path(__file__).resolve().parent.parent
        script = server_root / autostart['script']
        log_path = server_root / 'workspace' / 'logs' / f'{autostart["name"].lower()}-{port}.log'
        log_path.parent.mkdir(parents=True, exist_ok=True)
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        with log_path.open('ab') as log:
            proc = subprocess.Popen(
                [
                    str(py), str(script),
                    '--model-root', str(autostart.get('model_root') or str(SERVICES_ROOT / 'models')),
                    '--model', autostart['model_subdir'],  # weights 子目录名
                    '--host', '127.0.0.1', '--port', str(port),
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
        _spawned_procs.append(proc)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if _probe(url):
                return True
            if proc.poll() is not None:
                return False
            time.sleep(0.5)
        return _probe(url)


class MultiviewGenerator(BaseGenerator):
    """参数化的「单图 → 多视图图」适配器。

    ``autostart`` 提供该模型的自动拉起信息：python（venv 解释器）、marker
    （权重存在性 marker 文件）、model_root、model_subdir、script（service 文件）。
    产物为一张多视图拼图 PNG。
    """
    id = 'multiview'
    display_name = 'Multiview Generator'
    input_type = 'image'
    output_type = 'image'
    category = 'multiview'
    params = [
        {'id': 'steps', 'label': '采样步数', 'type': 'int', 'default': 30, 'min': 5, 'max': 200,
         'tooltip': '多视图扩散采样步数：越大越细腻但越慢'},
        {'id': 'seed', 'label': '随机种子', 'type': 'int', 'default': -1, 'min': -1, 'max': 999_999_999,
         'tooltip': '-1 = 每次随机；固定为正数可复现同一结果'},
        {'id': 'vram_note', 'label': '显存', 'type': 'label',
         'default': '生视图模型建议 6GB(RTX4050) 用低档参数；详见各模型 setup 脚本提示'},
    ]

    def __init__(self, *, gen_id: str, name: str, port: int, env_prefix: str,
                 autostart: dict, params: Optional[list[dict]] = None,
                 input_type: str = 'image') -> None:
        super().__init__()
        self.id = gen_id
        self.display_name = name
        self.port = port
        self.input_type = input_type
        env = env_prefix.upper()
        self._env = env
        self._url = (
            os.environ.get(f'MESHFORGE_{env}_URL')
            or f'http://127.0.0.1:{port}'
        ).rstrip('/')
        self._autostart = {
            'name': name,
            'python': os.environ.get(f'MESHFORGE_{env}_PY') or autostart.get('python'),
            'marker': os.environ.get(f'MESHFORGE_{env}_MARKER') or autostart.get('marker'),
            'model_root': os.environ.get(f'MESHFORGE_{env}_MODEL_ROOT') or autostart.get('model_root') or str(SERVICES_ROOT / 'models'),
            'model_subdir': autostart.get('model_subdir'),
            'script': autostart.get('script'),
        }
        if params is not None:
            self.params = params

    def hydrated_params(self, params: dict) -> dict:
        """按需子类覆写：把请求 params 翻译成 service 需要的表单字段。"""
        return {
            'steps': str(int(params.get('steps', 30))),
            'seed': str(int(params.get('seed', -1))),
        }

    def load(self, progress: Optional[ProgressFn] = None) -> None:
        ok = _probe(self._url)
        if not ok:
            ok = _ensure_service(self._url, self._autostart, progress)
        self._loaded = ok
        if progress:
            progress(1.0, f'{self.display_name} reachable' if ok else f'{self.display_name} NOT reachable')
        if not ok:
            raise RuntimeError(
                f'{self.display_name}（{self._url}）服务不可达且自动启动失败 — '
                f'请先完成环境搭建与权重落盘（见 README 部署章节），'
                f'查看 workspace/logs/{self._autostart["name"].lower()}-{self.port}.log'
            )

    def generate(
        self,
        image_path: Path,
        out_dir: Path,
        params: dict,
        progress: ProgressFn,
        cancel: threading.Event,
    ) -> Path:
        """把输入（图或文本）POST 给生视图服务，接收多视图拼图 PNG 并落盘。

        Args:
            image_path: 输入图片路径（text 驱动模型下仅占位）。
            out_dir: PNG 输出目录。
            params: 前端下发的采样步数/种子，或 text 模型的 prompt。
            progress: 进度回调（上传 / 接收 / 完成三段）。
            cancel: 取消事件，上传前与接收前各轮询一次。

        Returns:
            生成的多视图拼图路径（`<id>.png`）。
        """
        if not self._loaded:
            self.load(progress)

        progress(0.15, 'uploading input')
        if cancel.is_set():
            raise GenerationCancelled
        try:
            if self.input_type == 'text':
                fields = self.hydrated_params(params)
                if 'prompt' not in fields:
                    fields['prompt'] = str(params.get('prompt') or params.get('text') or '')
                payload = _multipart_post_text(f'{self._url}/generate', fields)
            else:
                payload = _multipart_post(
                    f'{self._url}/generate',
                    image_path,
                    self.hydrated_params(params),
                )
        except (OSError,) as exc:  # urllib HTTPError/URLError 均为 OSError 子类
            raise RuntimeError(f'{self.display_name} 调用失败: {exc}') from exc

        progress(0.7, 'receiving multiview sheet')
        if cancel.is_set():
            raise GenerationCancelled
        if not payload:
            raise RuntimeError(f'{self.display_name} 返回空响应')

        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f'{self.id}.png'
        out_path.write_bytes(payload)
        progress(1.0, 'done')
        return out_path