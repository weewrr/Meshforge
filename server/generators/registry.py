"""Registry of available generators.

P1: manual registration. Extensions installed into server/extensions/<id>/
(folder per extension) are discovered on startup and on /extensions/reload:
  * manifest.json — 清单：{id, display_name, kind, input, output, params}
  * generator.py  — model 类：定义 build_generator()，返回 BaseGenerator
  * processor.py  — process 类：定义 process_tool(mesh_path, out_dir, params, progress, cancel) -> Path

内置生成器（本文件模块末尾那批 `registry.register(...)`）是代码注册的，磁盘上
没有目录可删；用户"卸载"它们等于**停用**，id 落在 `disabled-extensions.json`
（见 `extension_state.py`），`register()` 装载时跳过，因此停用能扛住重启。
"""

import importlib.util
import sys
from pathlib import Path
from typing import Optional

from config import EXTENSIONS_DIR, MODELS_DIR, SERVICES_ROOT  # 集中配置：开发态在 server/ 下，打包态在用户数据目录
from extension_state import is_disabled
from .base import BaseGenerator
from .hunyuan import Hunyuan3DGenerator
from .hunyuan_full import Hunyuan3DFullGenerator
from .hunyuan_mv import Hunyuan3DMVGenerator
from .instantmesh import InstantMeshGenerator
from .multiview import MultiviewGenerator
from .imageopt import ImageOptGenerator


class GeneratorRegistry:
    """Registry of available generators.

    P1: manual registration. P4 will replace this with manifest-based
    discovery from an extensions/ directory.
    """

    def __init__(self) -> None:
        # 全部**代码注册**的内置生成器，含已被用户停用的：停用只是从
        # `_generators` 摘掉，实例仍留在这里，所以"恢复"不需要重启、也不用重跑
        # 构造代码（那批构造代码在模块顶层，已经跑过一次了）。
        self._all_generators: dict[str, BaseGenerator] = {}
        # 当前**可用**的生成器（内置 - 已停用 + 磁盘清单扫描到的）。
        self._generators: dict[str, BaseGenerator] = {}
        self._process_tools: dict[str, dict] = {}
        self._errors: dict[str, str] = {}
        self._manifests: dict[str, dict] = {}

    def register(self, generator: BaseGenerator) -> None:
        """登记一个**内置**生成器（清单扩展走 `scan_extensions()`，不经这里）。

        已停用（`disabled-extensions.json` 里记着）的 id 只进 `_all_generators`、
        不进行 `_generators`——这就是"卸载内置扩展能扛住重启"的实现点：模块重新
        导入时会再跑一遍 `register(...)`，但停用状态拦住了它。
        """
        self._all_generators[generator.id] = generator
        if is_disabled(generator.id):
            return
        self._generators[generator.id] = generator

    def builtin_ids(self) -> set[str]:
        """全部**代码内置**的生成器 id（含已停用的）。

        与 `_generators` 的区别：后者混入了 `scan_extensions()` 从磁盘装进来的
        清单扩展，那些是可以真删目录的，不属于"只能停用"的范畴。
        """
        return set(self._all_generators)

    def is_builtin(self, ext_id: str) -> bool:
        """该 id 是否由代码注册（`/extensions` 据此标 `builtin` 字段）。"""
        return ext_id in self._all_generators

    def restore(self, ext_id: str) -> bool:
        """把某个被停用的内置生成器放回可用集合。

        Args:
            ext_id: 扩展 id。

        Returns:
            是否真的恢复了（非内置、或本来就可用 → False）。
        """
        generator = self._all_generators.get(ext_id)
        if generator is None:
            return False
        self._generators[ext_id] = generator
        return True

    def get(self, generator_id: str) -> Optional[BaseGenerator]:
        return self._generators.get(generator_id)

    def describe_all(self) -> list[dict]:
        return [
            {
                'id': g.id,
                'display_name': g.display_name,
                'is_loaded': g.is_loaded,
                'kind': 'model',
                'input': g.input_type,
                'output': g.output_type,
                'category': g.category,
                'params': g.params,
                # 代码内置 = 磁盘无目录、卸载只能停用（可恢复）。
                'builtin': self.is_builtin(g.id),
            }
            for g in self._generators.values()
        ]

    # ─── Manifest-driven discovery (extensions/) ──────────────────────────

    def _load_generator_module(self, ext_dir: Path, filename: str) -> Optional[object]:
        """Import a python file from an extension folder as a standalone module."""
        target = ext_dir / filename
        if not target.is_file():
            return None
        name = f'meshforge_ext_{ext_dir.name}_{filename.split(".")[0]}'
        spec = importlib.util.spec_from_file_location(name, target)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module

    def scan_extensions(self) -> list[str]:
        """扫描 `EXTENSIONS_DIR` 并注册其中的生成器/处理器工具。

        Returns:
            加载失败的扩展 id 列表（失败原因按 id 存于 `self._errors`）。
        """
        errors: dict[str, str] = {}

        if not EXTENSIONS_DIR.is_dir():
            self._errors = {}
            return []

        for ext_dir in sorted(EXTENSIONS_DIR.iterdir()):
            if not ext_dir.is_dir() or ext_dir.name.startswith('.'):
                continue
            manifest_path = ext_dir / 'manifest.json'
            if not manifest_path.is_file():
                continue
            try:
                import json

                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
                ext_id = str(manifest.get('id') or ext_dir.name)
                kind = str(manifest.get('kind') or 'model')
                display_name = str(manifest.get('display_name') or ext_id)
                # 保留原始 manifest 快照，供 router 读取 hfRepo / hf_skip_prefixes /
                # hf_include_prefixes 等字段（动态拉取权重时使用）。
                self._manifests[ext_id] = manifest

                if kind == 'process':
                    module = self._load_generator_module(ext_dir, 'processor.py')
                    if module is None or not hasattr(module, 'process_tool'):
                        raise RuntimeError('processor.py missing process_tool()')
                    self._process_tools[ext_id] = {
                        'id': ext_id,
                        'display_name': display_name,
                        'kind': 'process',
                        'input': str(manifest.get('input') or 'mesh'),
                        'output': str(manifest.get('output') or 'mesh'),
                        'params': manifest.get('params') or [],
                        'fn': module.process_tool,
                    }
                else:
                    module = self._load_generator_module(ext_dir, 'generator.py')
                    if module is None or not hasattr(module, 'build_generator'):
                        raise RuntimeError('generator.py missing build_generator()')
                    generator = module.build_generator()
                    if not isinstance(generator, BaseGenerator):
                        raise RuntimeError('build_generator() did not return a BaseGenerator')
                    generator.id = ext_id  # manifest id wins
                    generator.display_name = display_name
                    generator.category = str(manifest.get('category') or 'mesh')
                    if manifest.get('params') is not None:
                        generator.params = manifest.get('params')
                    self._generators[ext_id] = generator
            except Exception as exc:  # noqa: BLE001 - per-extension isolation
                errors[ext_dir.name] = f'{type(exc).__name__}: {exc}'

        # 这里刻意**不**清理 `_generators`：它同时装着内置生成器（`register()`
        # 注册，磁盘上没有目录）与清单扩展，无法用"目录是否存在"来区分，
        # 误删会把内置生成器一起干掉。清单扩展卸载走的是 `unload()` 显式摘除，
        # 内置生成器的停用走 `disabled-extensions.json`。原先那个只 `pass` 的
        # 清理循环是死代码，已删。
        self._errors = errors
        return list(errors)

    def unload(self, ext_id: str) -> None:
        """从**可用**集合里摘掉一个扩展（生成器或处理器工具）。

        只动 `_generators` / `_process_tools` 等"当前生效"的字典；
        内置生成器的实例仍留在 `_all_generators`，因此 `restore()` 能立刻放回来。
        真正跨重启生效需要调用方把 id 写进停用记录（见 `extension_state.py`），
        这一步刻意留在 router 里，registry 只负责读、不负责写盘。
        """
        self._generators.pop(ext_id, None)
        self._process_tools.pop(ext_id, None)
        self._errors.pop(ext_id, None)
        self._manifests.pop(ext_id, None)

    def get_manifest(self, ext_id: str) -> dict:
        """Raw manifest of a manifest-loaded extension ({} if unknown)."""
        return self._manifests.get(ext_id, {})

    def process_tools(self) -> list[dict]:
        return [
            {k: v for k, v in tool.items() if k != 'fn'}
            for tool in self._process_tools.values()
        ]

    def get_process_tool(self, ext_id: str) -> Optional[dict]:
        return self._process_tools.get(ext_id)

    def load_errors(self) -> dict[str, str]:
        """返回本次扫描中各扩展的加载错误信息（id → 错误文案）。"""
        return dict(self._errors)


registry = GeneratorRegistry()
registry.register(Hunyuan3DGenerator())
# Full（单图 → 网格）：turbo(=hunyuan3d-2, 8768) 与 标准50步(=hunyuan3d-2-standard, 8775)
registry.register(Hunyuan3DFullGenerator())  # turbo: 8768 / hunyuan3d-dit-v2-0-turbo
registry.register(Hunyuan3DFullGenerator(
    port=8775,
    subfolder='hunyuan3d-dit-v2-0',
    gen_id='hunyuan3d-2-standard',
    name='Hunyuan3D 2 标准版 (50步, Real)',
))
# MV 多视图：turbo(=hunyuan3d-2-mv, 8771) / fast(=hunyuan3d-2-mv-fast, 8774) / standard(=hunyuan3d-2-mv-standard, 8776)
registry.register(Hunyuan3DMVGenerator())  # turbo: 8771 / hunyuan3d-dit-v2-mv-turbo
registry.register(Hunyuan3DMVGenerator(
    port=8774,
    subfolder='hunyuan3d-dit-v2-mv-fast',
    gen_id='hunyuan3d-2-mv-fast',
    name='Hunyuan3D 2 MV Fast (4视图, Real)',
))
registry.register(Hunyuan3DMVGenerator(
    port=8776,
    subfolder='hunyuan3d-dit-v2-mv',
    gen_id='hunyuan3d-2-mv-standard',
    name='Hunyuan3D 2 MV 标准版 (4视图, Real)',
))
# InstantMesh 单图 → 网格：large(=instantmesh, 8770) / base(=instantmesh-base, 8777, 低显存)
registry.register(InstantMeshGenerator())  # large: 8770 / instant-mesh-large.yaml
registry.register(InstantMeshGenerator(
    port=8777,
    config='configs/instant-mesh-base.yaml',
    gen_id='instantmesh-base',
    name='InstantMesh 低显存档 (Real)',
))
# ── 单图 → 多视图图 生视图模型（category='multiview'，与上图→网格 mesh 模型区分）。
#    三者权重在 SERVICES_ROOT/models/{MVDream, stable-zero123, Wonder3D_plus}/，
#    各跑独立 service；全部路径可经 MESHFORGE_SERVICES_ROOT / MESHFORGE_<NAME>_*
#    环境变量覆盖（见 multiview.py 文档字符串）。
registry.register(MultiviewGenerator(
    gen_id='mvdream',
    name='MVDream (4视图, Text)',
    port=8780,
    env_prefix='MVDREAM',
    input_type='text',  # MVDream 为文本驱动 text→多视图，不接受输入图片
    autostart={
        'python': str(SERVICES_ROOT / 'mvdream-venv' / 'Scripts' / 'python.exe'),
        'marker': str(SERVICES_ROOT / 'models' / 'MVDream' / 'sd-v2.1-base-4view.pt'),
        'model_root': str(SERVICES_ROOT / 'models'),
        'model_subdir': 'MVDream',
        'script': 'mvdream_service.py',
    },
))
registry.register(MultiviewGenerator(
    gen_id='stable-zero123',
    name='Stable Zero123 (单图, Real)',
    port=8781,
    env_prefix='ZERO123',
    autostart={
        'python': str(SERVICES_ROOT / 'zero123-venv' / 'Scripts' / 'python.exe'),
        'marker': str(SERVICES_ROOT / 'models' / 'stable-zero123' / 'stable_zero123.ckpt'),
        'model_root': str(SERVICES_ROOT / 'models'),
        'model_subdir': 'stable-zero123',
        'script': 'zero123_service.py',
    },
))
registry.register(MultiviewGenerator(
    gen_id='wonder3d-plus',
    name='Wonder3D Plus (6视图, Real)',
    port=8782,
    env_prefix='WONDER3D',
    autostart={
        'python': str(SERVICES_ROOT / 'wonder3d-venv' / 'Scripts' / 'python.exe'),
        'marker': str(SERVICES_ROOT / 'models' / 'Wonder3D_plus' / 'mv_controlnet'),
        'model_root': str(SERVICES_ROOT / 'models'),
        'model_subdir': 'Wonder3D_plus',
        'script': 'wonder3d_service.py',
    },
))
# ── 单图 → 单图 图像处理模型（category='image'，与 mesh｜multiview 区分的第 4 类）。
#    全部跑在共享 imageopt_service.py（端口 8783，venv SERVICES_ROOT/imageopt-venv），
#    靠 ImageOptGenerator 的 tool 字段区分具体模型。权重在
#    SERVICES_ROOT/models/ImageOptimization/<工具名>/。
#
#    这些节点**不放「显存 / 6GB 卡」这类说明文字**：节点上只应出现"改了会有用"的
#    控件，显卡档位属于 README 部署章节的事，摆在画布节点里是纯噪音。历史上这里
#    有 4 条 `type: 'label'` 的 vram_note（抠图 / 超分 / 人像修复 / Matting），
#    已全部删除；缺依赖的情况由 imageopt_service.py 在调用时返回明确中文指引，
#    比节点上那句泛泛的提示精确得多。
_IMAGEOOT_AUTOSTART = {
    'python': str(SERVICES_ROOT / 'imageopt-venv' / 'Scripts' / 'python.exe'),
    'marker': str(SERVICES_ROOT / 'models' / 'ImageOptimization' / 'M-LSD-tiny-LiteRT' / 'mlsd_fp16.tflite'),
    'model_root': str(SERVICES_ROOT / 'models'),
    'model_subdir': 'ImageOptimization',
    'script': 'imageopt_service.py',
}

# 抠图类通用参数：format=透明PNG/白色背景。人像修复/深度/线段/超分无需参数。
_MATTING_PARAMS = [
    {'id': 'format', 'label': '输出', 'type': 'select', 'default': 'rgba',
     'options': [{'value': 'rgba', 'label': '透明背景 PNG'},
                 {'value': 'white', 'label': '白色背景'}]},
]

registry.register(ImageOptGenerator(
    gen_id='image-rmbg',
    name='RMBG-2.0 抠图 (最强)',
    tool='rmbg',
    params=_MATTING_PARAMS,
    autostart=_IMAGEOOT_AUTOSTART,
))
registry.register(ImageOptGenerator(
    gen_id='image-birefnet',
    name='BiRefNet 通用抠图',
    tool='birefnet',
    params=_MATTING_PARAMS,
    autostart=_IMAGEOOT_AUTOSTART,
))
registry.register(ImageOptGenerator(
    gen_id='image-esrgan',
    name='Real-ESRGAN 超分 x2',
    tool='esrgan',
    autostart=_IMAGEOOT_AUTOSTART,
))
registry.register(ImageOptGenerator(
    gen_id='image-depth',
    name='Depth-Anything-V2 深度图',
    tool='depth',
    autostart=_IMAGEOOT_AUTOSTART,
))
registry.register(ImageOptGenerator(
    gen_id='image-moge',
    name='MoGe 深度/法线',
    tool='moge',
    params=[
        {'id': 'mode', 'label': '输出', 'type': 'select', 'default': 'depth',
         'options': [{'value': 'depth', 'label': '深度图'},
                     {'value': 'normal', 'label': '法线图'}]},
    ],
    autostart=_IMAGEOOT_AUTOSTART,
))
registry.register(ImageOptGenerator(
    gen_id='image-mlsd',
    name='M-LSD 直线检测',
    tool='mlsd',
    autostart=_IMAGEOOT_AUTOSTART,
))
registry.register(ImageOptGenerator(
    gen_id='image-codeformer',
    name='CodeFormer 人像修复',
    tool='codeformer',
    autostart=_IMAGEOOT_AUTOSTART,
))
registry.register(ImageOptGenerator(
    gen_id='image-matting',
    name='Universal Matting 人像',
    tool='matting',
    autostart=_IMAGEOOT_AUTOSTART,
))
registry.scan_extensions()
