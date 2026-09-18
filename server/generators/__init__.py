"""生成器插件包的统一导出入口。

本包集中所有「图→3D」生成器插件（Hunyuan3D / InstantMesh / 多视图 / 图像优化），
并对外暴露插件契约基类与异常。各插件通过 `registry.py` 注册后被 `server/jobs.py`
在 worker 线程内实例化并调用，进度与取消信号经由同一套 `progress` / `cancel` 约定。
"""

from .base import BaseGenerator, GenerationCancelled, ProgressFn

__all__ = ['BaseGenerator', 'GenerationCancelled', 'ProgressFn']
