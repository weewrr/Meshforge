"""Hunyuan3D-2-mini 生成器适配器（对接 HTTP 推理服务）。

真实模型的接入点：通过 `MESHFORGE_HUNYUAN_URL` 指向本地推理服务
（推荐暴露 HTTP API 的 Hunyuan3D 服务或 ComfyUI）。`load` 探针健康检查；
`generate` 把输入图片 POST 给服务并落盘返回的 GLB。

若服务不可达，`load` 会先用 hy3dgen 虚拟环境拉起自带的 `server/hunyuan_service.py`
子进程（路径经 `MESHFORGE_HUNYUAN_PY` / `MESHFORGE_HUNYUAN_MODEL_ROOT` 解析，回退默认安装位；
`MESHFORGE_HUNYUAN_AUTOSTART=0` 可关闭）。只有自动启动也失败才抛错——
开发期 mock-relief 仍是可用默认。

与 `server/jobs.py` 的协作：job 在 worker 线程内调用 `generate`，进度经 `progress`、
取消经 `cancel` 传递；子进程的拉起与超时等待发生在 `load` 阶段，常驻服务不会被
单次取消杀掉，但取消事件会中止当次推理请求。
"""

import io
import os
import subprocess
import sys
import threading
from http import HTTPStatus
import time
import uuid
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .base import BaseGenerator, GenerationCancelled, ProgressFn


def _service_url() -> str:
    import os
    # 默认值与 server/hunyuan_service.py 对齐（--port 8767）。可通过
    # MESHFORGE_HUNYUAN_URL 指向别的推理端点。
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


# ─── 本地推理服务自动拉起 ─────────────────────────────────────────────────────
# hunyuan_service.py 必须跑在 hy3dgen 虚拟环境里——与本服务端不是同一个解释器。
# 与其要求手动启动，不如在健康检查失败时由 load() 作为子进程拉起（前提是能探测到
# 本地安装）。子进程足够「独立」，可跨单次任务存活；其 stdout/stderr 写入
# workspace/logs/hunyuan-service.log。

# 仅 Windows 下探测这两个常见安装位（hy3dgen venv + 权重根目录）。
# 根目录统一取自 config.SERVICES_ROOT（MESHFORGE_SERVICES_ROOT 可覆盖）。
from config import SERVICES_ROOT

_AUTOSTART_CANDIDATES = [
    (str(SERVICES_ROOT / 'hy3dgen-venv' / 'Scripts' / 'python.exe'), str(SERVICES_ROOT / 'models')),
    (r'C:\github\hy3dgen-venv\Scripts\python.exe', r'C:\github\models'),
]

_SPAWN_LOCK = threading.Lock()
_spawned_proc: Optional['subprocess.Popen'] = None


def _probe(url: str) -> bool:
    try:
        with urlopen(f'{url}/health', timeout=3) as resp:  # noqa: S310
            return resp.status == HTTPStatus.OK
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
        # Windows 下 CREATE_NO_WINDOW 避免推理服务弹出控制台黑窗；其它平台无此标志。
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

        # 等待 uvicorn 应答 /health。模型仍在后台预热，
        # /generate 会一直阻塞到管线就绪为止。
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if _probe(url):
                return True
            if _spawned_proc.poll() is not None:
                return False  # process exited — see hunyuan-service.log
            time.sleep(0.5)
        return _probe(url)


class Hunyuan3DGenerator(BaseGenerator):
    """Hunyuan3D-2-mini 生成器：单图 → 网格，经本地 HTTP 推理服务完成。"""
    id = 'hunyuan3d-2-mini'
    display_name = 'Hunyuan3D 2 mini (Real)'
    input_type = 'image'
    output_type = 'mesh'
    # 数字参数一律以 pin_only 形式出现：节点上不摆输入框（默认值足够日常使用），
    # 要改就从左侧引脚喂一个数值变量——执行时 resolveParamPins 会按 schema 的
    # int/float 把引脚上的文本协调成数字，空文本按"没给值"回退到默认值。
    # 下拉框（重建分辨率 / 去底部圆盘）不在此列：它的"选项"本身就是信息，
    # 摆成一行文字反而看不懂，故仍保留控件。
    params = [
        {'id': 'steps', 'label': '采样步数', 'type': 'int', 'default': 20, 'min': 5, 'max': 100,
         'pin_only': True,
         'tooltip': '扩散采样步数：越大越细腻但越慢；默认 20 适合快速出模'},
        {'id': 'guidance', 'label': '引导强度', 'type': 'float', 'default': 4.0, 'min': 1.0, 'max': 10.0,
         'pin_only': True,
         'tooltip': 'CFG 引导强度：越大越贴合输入图，过高可能过饱和'},
        {'id': 'octree', 'label': '重建分辨率', 'type': 'select', 'default': 256,
         'options': [
             {'value': 256, 'label': '标准 256（省显存）'},
             {'value': 320, 'label': '精细 320（推荐）'},
             {'value': 384, 'label': '最高 384（细节最佳，6GB 显存有 OOM 风险）'},
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
        """把输入图片 POST 给推理服务，接收返回的 GLB 并落盘。

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
