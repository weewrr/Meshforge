"""诊断端点（优化文档 7.4 可观测性）。

- `_RingBufferHandler`：挂在 root logger 上的内存环形缓冲（默认 500 条），
  任意模块用 `logging.getLogger(...)` 打的日志都会留有最近现场；
- `GET /diagnostics/bundle`：把"环境元信息 + 最近任务终态 + 最近日志"打包成
  zip 一次性带走。需要 Bearer token（含数据目录等本机信息，不公开）；
  **不含** token 本身与 workspace 产物文件——只做诊断，不做数据导出。
"""

import io
import logging
import os
import platform
import sys
import time
import zipfile
from collections import deque
from typing import Optional

from fastapi import APIRouter, Response

from config import DATA_DIR

router = APIRouter(tags=['diagnostics'])

# 进程启动时刻（main.py 里有同名的；这里独立记录，模块加载即生效）。
_START_TIME = time.time()


class _RingBufferHandler(logging.Handler):
    """内存环形日志缓冲：保留最近 capacity 条格式化记录，供诊断包取用。"""

    def __init__(self, capacity: int = 500) -> None:
        super().__init__()
        self.buffer: deque[str] = deque(maxlen=capacity)
        self.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(name)s: %(message)s'))

    def emit(self, record: logging.LogRecord) -> None:  # noqa: D102
        try:
            self.buffer.append(self.format(record))
        except Exception:  # noqa: BLE001 - 日志收集永不抛出
            pass


ring = _RingBufferHandler()


def install_ring_handler() -> None:
    """把环形缓冲挂到 root logger。

    各业务 logger（meshforge.api / system_stats / ...）默认向 root 传播，
    因此无需逐个挂载。注意：root 的默认级别是 WARNING，但**过滤器在各级
    logger 自身生效**——只要业务 logger 自己 setLevel(INFO)，INFO 记录就能
    传播到这里；root 级别不影响已到达的记录。
    """
    root = logging.getLogger()
    root.addHandler(ring)


def _meta() -> dict:
    """环境元信息：版本 / 平台 / 运行时长 / 目录布局。不含任何凭据。"""
    from jobs import MAX_CONCURRENT_PER_GENERATOR

    return {
        'app': 'meshforge',
        'python': sys.version.split()[0],
        'platform': platform.platform(),
        'pid': os.getpid(),
        'uptimeSeconds': round(time.time() - _START_TIME, 1),
        'port': int(os.environ.get('MESHFORGE_API_PORT') or 8766),
        'dataDir': str(DATA_DIR),
        'maxConcurrentPerModel': MAX_CONCURRENT_PER_GENERATOR,
        'tokenConfigured': bool(os.environ.get('MESHFORGE_API_TOKEN')),
    }


@router.get('/diagnostics/bundle')
def diagnostics_bundle() -> Response:
    """GET /diagnostics/bundle — 导出诊断 zip（需 Bearer token）。

    内容：
    - `meta.json`：环境元信息；
    - `recent-jobs.json`：最近 100 条任务终态（SQLite jobstore）；
    - `recent-logs.txt`：最近 500 条日志（进程内环形缓冲）。
    """
    import json

    from jobstore import store as _jobstore

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('meta.json', json.dumps(_meta(), indent=2, ensure_ascii=False))
        zf.writestr(
            'recent-jobs.json',
            json.dumps(_jobstore.recent(limit=100), indent=2, ensure_ascii=False),
        )
        zf.writestr('recent-logs.txt', '\n'.join(ring.buffer))

    return Response(
        content=buf.getvalue(),
        media_type='application/zip',
        headers={'Content-Disposition': 'attachment; filename="meshforge-diagnostics.zip"'},
    )
