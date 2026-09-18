"""导出 OpenAPI 快照（优化文档 7.2）。

用法（在仓库根目录）：
    server\\.venv\\Scripts\\python.exe scripts/export_openapi.py           # 导出/更新 docs/openapi.json
    server\\.venv\\Scripts\\python.exe scripts/export_openapi.py --check   # 对比快照，漂移则退出码 1

快照提交进仓库；CI 或本地跑 `npm run openapi:check`，任何 response model /
路由改动未同步快照都会立刻暴露——契约变更必须显式过审。
"""

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / 'docs' / 'openapi.json'


def load_spec() -> dict:
    """导入 app 并生成 OpenAPI 文档。

    main.py 导入时有副作用（ensure_dirs / token 文件生成），全部隔离到
    一次性临时数据目录，不污染仓库与真实数据目录。
    """
    os.environ['MESHFORGE_DATA_DIR'] = tempfile.mkdtemp(prefix='meshforge_openapi_')
    sys.path.insert(0, str(ROOT / 'server'))
    from main import app

    return app.openapi()


def canonical(obj) -> str:
    """稳定序列化：排序键，便于 diff 与幂等导出。"""
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + '\n'


def main() -> int:
    check = '--check' in sys.argv
    spec = canonical(load_spec())
    if check:
        if not SNAPSHOT.is_file():
            print(f'FAIL: snapshot missing: {SNAPSHOT}')
            return 1
        current = SNAPSHOT.read_text(encoding='utf-8')
        if current != spec:
            print('FAIL: OpenAPI snapshot drifted. Run: npm run openapi')
            return 1
        print('OK: OpenAPI snapshot in sync.')
        return 0
    SNAPSHOT.write_text(spec, encoding='utf-8')
    print(f'Wrote {SNAPSHOT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
