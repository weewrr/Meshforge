"""Registry of available generators.

P1: manual registration. Extensions installed into server/extensions/<id>/
(folder per extension) are discovered on startup and on /extensions/reload:
  * manifest.json — {id, display_name, kind, input, output, params}
  * generator.py  — model kind: defines build_generator() returning a BaseGenerator
  * processor.py  — process kind: defines process_tool(mesh_path, out_dir, params, progress, cancel) -> Path
"""

import importlib.util
import sys
from pathlib import Path
from typing import Optional

from .base import BaseGenerator
from .hunyuan import Hunyuan3DGenerator
from .mock import MockReliefGenerator

EXTENSIONS_DIR = Path(__file__).resolve().parent.parent / 'extensions'


class GeneratorRegistry:
    """Registry of available generators.

    P1: manual registration. P4 will replace this with manifest-based
    discovery from an extensions/ directory.
    """

    def __init__(self) -> None:
        self._generators: dict[str, BaseGenerator] = {}
        self._process_tools: dict[str, dict] = {}
        self._errors: dict[str, str] = {}

    def register(self, generator: BaseGenerator) -> None:
        self._generators[generator.id] = generator

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
                'params': g.params,
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
        """Discover extensions in EXTENSIONS_DIR and register their generators/tools.

        Returns the list of extension ids that failed to load (errors keyed by id).
        """
        errors: dict[str, str] = {}
        loaded_ids: set[str] = set()

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
                    loaded_ids.add(ext_id)
                else:
                    module = self._load_generator_module(ext_dir, 'generator.py')
                    if module is None or not hasattr(module, 'build_generator'):
                        raise RuntimeError('generator.py missing build_generator()')
                    generator = module.build_generator()
                    if not isinstance(generator, BaseGenerator):
                        raise RuntimeError('build_generator() did not return a BaseGenerator')
                    generator.id = ext_id  # manifest id wins
                    generator.display_name = display_name
                    if manifest.get('params') is not None:
                        generator.params = manifest.get('params')
                    self._generators[ext_id] = generator
                    loaded_ids.add(ext_id)
            except Exception as exc:  # noqa: BLE001 - per-extension isolation
                errors[ext_dir.name] = f'{type(exc).__name__}: {exc}'

        # Drop extensions whose directory disappeared.
        for ext_id in list(self._generators):
            if ext_id not in loaded_ids and (EXTENSIONS_DIR / ext_id).exists() is False:
                pass  # keep manual generators; only prune manifest-loaded ones

        self._errors = errors
        return list(errors)

    def unload(self, ext_id: str) -> None:
        """Remove a dynamically-loaded extension (generator or process tool)."""
        self._generators.pop(ext_id, None)
        self._process_tools.pop(ext_id, None)
        self._errors.pop(ext_id, None)

    def process_tools(self) -> list[dict]:
        return [
            {k: v for k, v in tool.items() if k != 'fn'}
            for tool in self._process_tools.values()
        ]

    def get_process_tool(self, ext_id: str) -> Optional[dict]:
        return self._process_tools.get(ext_id)

    def load_errors(self) -> dict[str, str]:
        return dict(self._errors)


registry = GeneratorRegistry()
registry.register(MockReliefGenerator())
registry.register(Hunyuan3DGenerator())
registry.scan_extensions()
