"""In-memory job registry with cooperative cancellation.

Jobs run in worker threads (via asyncio.to_thread) so the event loop stays
responsive; cancellation is cooperative — generators poll the cancel event
between pipeline stages and raise GenerationCancelled.
"""

import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Optional

ProgressFn = Callable[[float, str], None]


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


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._cancel_flags: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def create(self, generator_id: str) -> Job:
        job = Job(job_id=uuid.uuid4().hex[:12], generator_id=generator_id)
        with self._lock:
            self._jobs[job.job_id] = job
            self._cancel_flags[job.job_id] = threading.Event()
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def request_cancel(self, job_id: str) -> bool:
        flag = self._cancel_flags.get(job_id)
        if flag is None:
            return False
        flag.set()
        return True

    def _cancel_flag(self, job_id: str) -> threading.Event:
        return self._cancel_flags.get(job_id, threading.Event())

    async def run(self, job: Job, image_path: Path, out_dir: Path, params: dict) -> None:
        import asyncio

        from generators.base import GenerationCancelled
        from generators.registry import registry

        job.state = JobState.RUNNING

        generator = registry.get(job.generator_id)
        if generator is None:
            job.state = JobState.FAILED
            job.error = f"unknown generator '{job.generator_id}'"
            return

        cancel = self._cancel_flag(job.job_id)

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

            if cancel.is_set():
                job.state = JobState.CANCELLED
            else:
                job.progress = 1.0
                job.state = JobState.SUCCEEDED
                job.result_url = f'/files/{job.job_id}/{glb_path.name}'
        except GenerationCancelled:
            job.state = JobState.CANCELLED
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI via job.error
            job.state = JobState.FAILED
            job.error = f'{type(exc).__name__}: {exc}'


jobs = JobRegistry()
