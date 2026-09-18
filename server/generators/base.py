"""Generator contract for Meshforge.

A generator owns exactly one model (or pipeline stage). Implementations must:
  * 把全部重活放在 ``generate`` 里（它由工作线程调用），
  * 经 ``progress`` 回调上报进度，
  * 在阶段间轮询 ``cancel`` 并抛出 ``GenerationCancelled``，
  * 把 ``.glb`` 写入 ``out_dir`` 并返回其路径。
"""

import threading
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Callable, Optional

ProgressFn = Callable[[float, str], None]


class GenerationCancelled(Exception):
    """Raised inside generate()/load() when the user requested cancellation."""


class BaseGenerator(ABC):
    id: str = 'base'
    display_name: str = 'Base Generator'
    input_type: str = 'image'
    output_type: str = 'mesh'
    # 类别：区分「图→网格」生成建模模型（mesh）与「图→多视图图」生视图模型
    # （multiview）。前端据此把两类生成器分开展示，jobs 层也据此返回不同产物。
    category: str = 'mesh'
    params: list[dict] = []  # ParamSchema list, drives the node UI

    def __init__(self) -> None:
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self, progress: Optional[ProgressFn] = None) -> None:
        """Load model weights onto the compute device. Override if needed."""
        self._loaded = True
        if progress:
            progress(1.0, 'loaded')

    def unload(self) -> None:
        """释放设备显存/内存。需要自定义卸载逻辑时重写。"""
        self._loaded = False

    @abstractmethod
    def generate(
        self,
        image_path: Path,
        out_dir: Path,
        params: dict,
        progress: ProgressFn,
        cancel: threading.Event,
    ) -> Path:
        """对输入图片跑推理，把 `.glb` 写入 `out_dir` 并返回其路径。

        Args:
            image_path: 输入图片路径。
            out_dir: 产物输出目录（`.glb` 落盘处）。
            params: 前端节点下发的参数字典。
            progress: 进度回调 `(比例, 文案)`，供前端轮询展示。
            cancel: 取消事件，各阶段间轮询；置位时抛 `GenerationCancelled`。

        Returns:
            生成的 `.glb` 文件路径。
        """
        raise NotImplementedError
