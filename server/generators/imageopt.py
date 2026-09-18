"""单图 → 单图 图像预处理 适配器族（图→图，与「图→网格」建模模型区分）。

与 ``multiview`` 生视图模型不同，这批模型做的是**单图图像处理**（抠图 /
超分 / 深度 / 法线 / 直线检测 / 修复……），产物仍是**单张 PNG**。同样的：

  * ``category = 'image'`` —— describe_all() / /extensions 据此把图像处理模型
    单独分一组展示，与 ``category='mesh'``（图→网格）、``category='multiview'``
    （图→多视图图）区分；
  * ``output_type = 'image'`` —— 产物为处理后的图片，由共享推理服务
    ``imageopt_service.py`` 返回 PNG 字节，适配器写入 out_dir/<id>.png。

所有图像处理模型共用一个推理服务（本模块的每个实例只是参数化的适配器，
靠 ``tool`` 字段区分具体模型），该服务跑在独立 venv（镜像 multiview 的自动
拉起模式：查 venv 解释器 + 权重 marker 文件，缺一即不自动启动并在 load()
给出中文提示）。环境变量覆盖：

  MESHFORGE_IMAGEOPT_URL / MESHFORGE_IMAGEOPT_PY / MESHFORGE_IMAGEOPT_MODEL_ROOT
  MESHFORGE_IMAGEOPT_AUTOSTART=0  关闭自动拉起
"""

import os
import threading
from pathlib import Path
from typing import Optional

from .base import BaseGenerator, GenerationCancelled, ProgressFn
from .hunyuan import _multipart_post
from .multiview import _ensure_service, _probe
from config import SERVICES_ROOT


class ImageOptGenerator(BaseGenerator):
    """参数化的「单图 → 单图」图像预处理适配器。

    ``autostart`` 提供共享 imageopt 推理服务的自动拉起信息：python（venv 解释
    器）、marker（权重存在性 marker 文件）、model_root、model_subdir、script。
    每个实例通过 ``tool`` 区分 service 内部要调用哪个模型。产物为单张 PNG。
    """
    id = 'imageopt'
    display_name = 'Image Optimizer'
    input_type = 'image'
    output_type = 'image'
    category = 'image'
    params: list[dict] = []

    def __init__(self, *, gen_id: str, name: str, tool: str,
                 params: Optional[list[dict]] = None,
                 autostart: Optional[dict] = None) -> None:
        super().__init__()
        self.id = gen_id
        self.display_name = name
        self._tool = tool
        env = 'IMAGEOPT'
        self._env = env
        self._url = (
            os.environ.get('MESHFORGE_IMAGEOPT_URL')
            or r'http://127.0.0.1:8783'
        ).rstrip('/')
        self._autostart = {
            'name': 'imageopt',
            'python': os.environ.get('MESHFORGE_IMAGEOPT_PY')
            or (autostart or {}).get('python'),
            'marker': os.environ.get('MESHFORGE_IMAGEOPT_MARKER')
            or (autostart or {}).get('marker'),
            'model_root': os.environ.get('MESHFORGE_IMAGEOPT_MODEL_ROOT')
            or (autostart or {}).get('model_root')
            or str(SERVICES_ROOT / 'models'),
            'model_subdir': (autostart or {}).get('model_subdir', 'ImageOptimization'),
            'script': 'imageopt_service.py',
        }
        if params is not None:
            self.params = params

    def hydrated_params(self, params: dict) -> dict:
        """按需子类覆写：把请求 params 翻译成 service 需要的表单字段。"""
        out: dict[str, str] = {'tool': self._tool}
        for p in self.params:
            pid = p['id']
            if pid in params:
                out[pid] = str(params[pid])
        return out

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
                f'请先完成环境搭建与权重落盘（见 scripts/setup-imageopt-server.bat），'
                f'查看 workspace/logs/imageopt-8783.log'
            )

    def generate(
        self,
        image_path: Path,
        out_dir: Path,
        params: dict,
        progress: ProgressFn,
        cancel: threading.Event,
    ) -> Path:
        """把输入图片 POST 给共享 imageopt 服务，接收处理后的 PNG 并落盘。

        Args:
            image_path: 输入图片路径。
            out_dir: PNG 输出目录。
            params: 前端下发的模型参数（经 `hydrated_params` 翻译为表单字段）。
            progress: 进度回调（上传 / 接收 / 完成三段）。
            cancel: 取消事件，上传前与接收前各轮询一次。

        Returns:
            生成的处理后图片路径（`<id>.png`）。
        """
        if not self._loaded:
            self.load(progress)

        progress(0.15, 'uploading input image')
        if cancel.is_set():
            raise GenerationCancelled
        try:
            payload = _multipart_post(
                f'{self._url}/generate',
                image_path,
                self.hydrated_params(params),
            )
        except OSError as exc:  # urllib HTTPError/URLError 均为 OSError 子类
            raise RuntimeError(f'{self.display_name} 调用失败: {exc}') from exc

        progress(0.7, 'receiving processed image')
        if cancel.is_set():
            raise GenerationCancelled
        if not payload:
            raise RuntimeError(f'{self.display_name} 返回空响应')

        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f'{self.id}.png'
        out_path.write_bytes(payload)
        progress(1.0, 'done')
        return out_path