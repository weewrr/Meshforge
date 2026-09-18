"""任务终态的 SQLite 持久化（优化文档 4.1）。

内存注册表（jobs.py）只保留活跃与最近结束的任务（TTL 清理）；这里把每个
任务的终态（成功/失败/取消）追加写入 `<DATA_DIR>/jobs.db`，后端重启后
`/generate/jobs/{id}` 仍能查到历史任务的最终状态与产物地址。

设计约束：
- 只存元数据，不存产物文件（大文件仍留在 workspace 文件系统）；
- 连接按调用即开即用，规避 sqlite3 的跨线程限制；
- 持久化失败绝不影响任务本身——所有入口都吞掉异常。
"""

import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional

from config import DATA_DIR

DB_PATH = DATA_DIR / 'jobs.db'

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id       TEXT PRIMARY KEY,
    generator_id TEXT NOT NULL,
    state        TEXT NOT NULL,
    progress     REAL NOT NULL DEFAULT 0,
    message      TEXT DEFAULT '',
    result_url   TEXT,
    error        TEXT,
    created_at   REAL,
    finished_at  REAL
)
"""


class JobStore:
    """jobs 表的极简封装：写入终态、按 id 查询、列出最近记录。"""

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self._path = Path(db_path) if db_path else DB_PATH
        self._write_lock = threading.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        return conn

    def record_terminal(
        self,
        *,
        job_id: str,
        generator_id: str,
        state: str,
        progress: float,
        message: str,
        result_url: Optional[str],
        error: Optional[str],
        created_at: float,
        finished_at: float,
    ) -> None:
        """写入/覆盖一个任务的终态行；失败静默（不影响任务本身）。"""
        try:
            with self._write_lock, self._connect() as conn:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO jobs
                        (job_id, generator_id, state, progress, message,
                         result_url, error, created_at, finished_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (job_id, generator_id, state, progress, message,
                     result_url, error, created_at, finished_at),
                )
        except sqlite3.Error:
            pass

    def upsert_active(
        self,
        *,
        job_id: str,
        generator_id: str,
        state: str,
        progress: float = 0.0,
        message: str = '',
        created_at: Optional[float] = None,
    ) -> None:
        """登记/更新一个非终态任务行（pending → running），供重启后识别被中断的任务。

        与 {@link record_terminal} 的分工：任务在内存注册表里进入 pending /
        running 时同步落库一次（低频，只在状态切换时写）；终态仍由
        `record_terminal` 覆盖。失败静默（不影响任务本身）。
        """
        try:
            with self._write_lock, self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO jobs
                        (job_id, generator_id, state, progress, message, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(job_id) DO UPDATE SET
                        state = excluded.state,
                        progress = excluded.progress,
                        message = excluded.message
                    """,
                    (job_id, generator_id, state, progress, message, created_at),
                )
        except sqlite3.Error:
            pass

    def mark_interrupted(self, error: str) -> list[str]:
        """把上一次运行遗留的非终态任务统一标记为 failed，返回受影响的 job_id。

        后端重启时调用（main.py 启动路径）：SQLite 里仍处于 pending / running
        的行属于"进程被杀时还没跑完"的任务——内存注册表已随进程消失，没有任何
        机制会再把它们推进到终态，前端查询会永远停在转圈。诚实标记为失败
        （interrupted by backend restart）比永久 pending 或凭空消失都好。
        """
        try:
            with self._write_lock, self._connect() as conn:
                rows = conn.execute(
                    "SELECT job_id FROM jobs WHERE state IN ('pending', 'running')"
                ).fetchall()
                ids = [r['job_id'] for r in rows]
                if ids:
                    conn.execute(
                        "UPDATE jobs SET state = 'failed', error = ?, finished_at = ? "
                        "WHERE state IN ('pending', 'running')",
                        (error, time.time()),
                    )
                return ids
        except sqlite3.Error:
            return []

    def get(self, job_id: str) -> Optional[dict]:
        """按 id 查询历史任务终态；不存在返回 None。"""
        try:
            with self._connect() as conn:
                row = conn.execute(
                    'SELECT * FROM jobs WHERE job_id = ?', (job_id,)
                ).fetchone()
        except sqlite3.Error:
            return None
        return dict(row) if row is not None else None

    def recent(self, limit: int = 50) -> list[dict]:
        """按结束时间倒序列出最近的任务终态（诊断/历史列表用）。"""
        try:
            with self._connect() as conn:
                rows = conn.execute(
                    'SELECT * FROM jobs ORDER BY finished_at DESC LIMIT ?', (limit,)
                ).fetchall()
        except sqlite3.Error:
            return []
        return [dict(r) for r in rows]


# 进程级单例：jobs.py 与路由共享。
store = JobStore()

# 时间戳辅助（便于测试与调用方统一口径）。
_now = time.time
