"""Generator contract for Meshforge.

A generator owns exactly one model (or pipeline stage). Implementations must:
  * run all heavy work inside ``generate`` (it is called from a worker thread),
  * report progress via the ``progress`` callback,
  * poll ``cancel`` between stages and raise ``GenerationCancelled``,
  * write a ``.glb`` into ``out_dir`` and return its path.
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
        """Free device memory. Override if needed."""
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
        """Run inference on the input image, write a .glb into out_dir, return its path."""
        raise NotImplementedError
