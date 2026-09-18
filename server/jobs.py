"""内存任务注册表与协作式取消。

任务在 worker 线程里跑（通过 `asyncio.to_thread`），事件循环由此保持响应；
取消是协作式的——生成器在各流水线阶段之间轮询取消事件，命中后抛出
`GenerationCancelled`。取消标志用 `threading.Event` 在主线程与 worker 间共享。

并发与生命周期治理（优化文档 4.1）：
- `_jobs` / `_cancel_flags` 的所有读写统一持 `_lock`，避免并发请求读到中间状态；
- 已结束任务按 TTL（默认 6 小时）由后台守护线程清理，任务记录与取消标记
  不再无限累积；结果文件仍留在 workspace，由设置页的清理端点负责。
- 每个 generator 有并发上限（默认 1）：超限任务进入队列等待而不是直接
  争抢显存，等待期间可取消；上限可用 MESHFORGE_MAX_CONCURRENT_PER_MODEL 调整。
- 终态经 jobstore 同步写入 SQLite（jobs.db），后端重启后仍可查询历史任务。
"""

import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Optional

from jobstore import store as _jobstore

ProgressFn = Callable[[float, str], None]

# 已结束（succeeded/failed/cancelled）任务在内存中保留的最长时间。
JOB_TTL_SECONDS = 6 * 3600
# TTL 清理线程的扫描间隔。
JOB_REAP_INTERVAL_SECONDS = 600
# 同一模型同时执行的任务上限（其余排队等待，可取消）。
MAX_CONCURRENT_PER_GENERATOR = max(1, int(os.environ.get('MESHFORGE_MAX_CONCURRENT_PER_MODEL') or 1))

_TERMINAL_STATES = frozenset({'succeeded', 'failed', 'cancelled'})


class JobState(str, Enum):
    PENDING = 'pending'
    RUNNING = 'running'
    SUCCEEDED = 'succeeded'
    FAILED = 'failed'
    CANCELLED = 'cancelled'


@dataclass
class Job:
    job_id: str
    generator_id: str
    state: JobState = JobState.PENDING
    progress: float = 0.0
    message: str = ''
    result_url: Optional[str] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    # 任务进入终态的时刻；用于 TTL 清理（运行中任务不参与清理）。
    finished_at: Optional[float] = None


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._cancel_flags: dict[str, threading.Event] = {}
        self._lock = threading.Lock()
        # 每个 generator 一个并发槽（信号量），超限任务排队而非争抢显存。
        self._gen_slots: dict[str, threading.Semaphore] = {}

    def _gen_slot(self, generator_id: str) -> threading.Semaphore:
        with self._lock:
            slot = self._gen_slots.get(generator_id)
            if slot is None:
                slot = threading.Semaphore(MAX_CONCURRENT_PER_GENERATOR)
                self._gen_slots[generator_id] = slot
            return slot

    def create(self, generator_id: str) -> Job:
        """登记一个新任务并返回它。

        同时为该任务建一个取消 `threading.Event`，与 `Job` 一并存入两张表。
        内存登记成功后同步落库一条 pending 行：后端若在任务跑完前被重启，
        启动路径的 `mark_interrupted` 能据库把它标记为失败，而不是让前端
        永远等一个已不存在的任务。
        """
        job = Job(job_id=uuid.uuid4().hex[:12], generator_id=generator_id)
        with self._lock:
            self._jobs[job.job_id] = job
            self._cancel_flags[job.job_id] = threading.Event()
        try:
            _jobstore.upsert_active(
                job_id=job.job_id,
                generator_id=job.generator_id,
                state=JobState.PENDING.value,
                message='queued',
                created_at=job.created_at,
            )
        except Exception:  # noqa: BLE001 - 落库失败不影响任务本身
            pass
        return job

    def get(self, job_id: str) -> Optional[Job]:
        """按 id 取出任务；不存在时返回 `None`。"""
        with self._lock:
            return self._jobs.get(job_id)

    def request_cancel(self, job_id: str) -> bool:
        """置位该任务的取消事件，请求协作式取消。

        返回 `False` 表示任务不存在（已结束或 id 无效）。
        """
        with self._lock:
            flag = self._cancel_flags.get(job_id)
        if flag is None:
            return False
        flag.set()
        return True

    def _cancel_flag(self, job_id: str) -> threading.Event:
        """取任务的取消事件；若已不存在则给一个全新的（默认未置位）。"""
        with self._lock:
            flag = self._cancel_flags.get(job_id)
        return flag if flag is not None else threading.Event()

    def reap_expired(self) -> int:
        """清理超过 TTL 的已结束任务（元数据 + 取消标记），返回清理数量。"""
        now = time.time()
        expired: list[str] = []
        with self._lock:
            for job_id, job in self._jobs.items():
                if (
                    job.state.value in _TERMINAL_STATES
                    and job.finished_at is not None
                    and now - job.finished_at > JOB_TTL_SECONDS
                ):
                    expired.append(job_id)
            for job_id in expired:
                self._jobs.pop(job_id, None)
                self._cancel_flags.pop(job_id, None)
        return len(expired)

    def _start_reaper(self) -> None:
        """启动 TTL 守护线程（幂等；进程级只跑一次）。"""
        if getattr(self, '_reaper_started', False):
            return
        self._reaper_started = True

        def _loop() -> None:
            while True:
                time.sleep(JOB_REAP_INTERVAL_SECONDS)
                try:
                    self.reap_expired()
                except Exception:  # noqa: BLE001 - 清理失败不应杀掉守护线程
                    continue

        threading.Thread(target=_loop, name='job-ttl-reaper', daemon=True).start()

    def mark_finished(self, job: Job, state: JobState, error: Optional[str] = None) -> None:
        """统一写入终态：内存记录 + SQLite 持久化（持久化失败不影响任务）。"""
        job.state = state
        job.error = error
        job.finished_at = time.time()
        try:
            _jobstore.record_terminal(
                job_id=job.job_id,
                generator_id=job.generator_id,
                state=state.value,
                progress=job.progress,
                message=job.message,
                result_url=job.result_url,
                error=job.error,
                created_at=job.created_at,
                finished_at=job.finished_at,
            )
        except Exception:  # noqa: BLE001 - 持久化失败不能拖垮任务收尾
            pass

    async def run(self, job: Job, image_path: Path, out_dir: Path, params: dict) -> None:
        import asyncio

        from generators.base import GenerationCancelled
        from generators.registry import registry

        # 首次真正跑任务时顺带把 TTL 守护线程拉起来。
        self._start_reaper()

        generator = registry.get(job.generator_id)
        if generator is None:
            self.mark_finished(job, JobState.FAILED, f"unknown generator '{job.generator_id}'")
            return

        cancel = self._cancel_flag(job.job_id)
        slot = self._gen_slot(job.generator_id)

        # 并发槽排队：同一模型已被占满时进入队列（可取消），
        # 避免多任务同时加载/推理争抢显存（优化文档 4.1）。
        while not slot.acquire(blocking=False):
            if cancel.is_set():
                self.mark_finished(job, JobState.CANCELLED)
                return
            job.message = 'Queued: waiting for a free model slot'
            await asyncio.sleep(0.5)

        try:
            job.message = ''
            job.state = JobState.RUNNING
            # 状态切换同步落库（pending → running），维持重启恢复的数据链。
            try:
                _jobstore.upsert_active(
                    job_id=job.job_id,
                    generator_id=job.generator_id,
                    state=JobState.RUNNING.value,
                    progress=job.progress,
                    created_at=job.created_at,
                )
            except Exception:  # noqa: BLE001
                pass

            def report(progress: float, message: str = '') -> None:
                if cancel.is_set():
                    raise GenerationCancelled
                job.progress = max(0.0, min(1.0, progress))
                if message:
                    job.message = message

            try:
                if not generator.is_loaded:
                    await asyncio.to_thread(generator.load, report)

                out_dir.mkdir(parents=True, exist_ok=True)
                glb_path = await asyncio.to_thread(
                    generator.generate, image_path, out_dir, params, report, cancel
                )

                # 生成结束后再次检查取消标志：若推理中途被取消，则不视为成功。
                if cancel.is_set():
                    self.mark_finished(job, JobState.CANCELLED)
                else:
                    job.progress = 1.0
                    job.result_url = f'/files/{job.job_id}/{glb_path.name}'
                    self.mark_finished(job, JobState.SUCCEEDED)
            except GenerationCancelled:
                self.mark_finished(job, JobState.CANCELLED)
            except Exception as exc:  # noqa: BLE001 - 捕获后写入 job.error 暴露给 UI
                self.mark_finished(job, JobState.FAILED, f'{type(exc).__name__}: {exc}')
        finally:
            # 无论成败都释放并发槽，让队列里的下一个任务得以启动。
            slot.release()


jobs = JobRegistry()
