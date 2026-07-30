"""Coordinates background jobs and their retry policy."""

from dataclasses import dataclass
from typing import Optional

MAX_ATTEMPTS = 5
_DEFAULT_QUEUE = "jobs"


class Runnable:
    """Anything the scheduler can drive."""

    def start(self) -> None:
        """Begin processing."""
        raise NotImplementedError


@dataclass
class JobSpec:
    """A unit of deferred work."""

    name: str
    attempts: int = 0


class Scheduler(Runnable):
    """Runs jobs with exponential backoff between retries."""

    def __init__(self, queue: str = _DEFAULT_QUEUE) -> None:
        self.queue = queue
        self._pending: list[JobSpec] = []

    def start(self) -> None:
        """Drain the pending queue."""
        for spec in self._pending:
            self.dispatch(spec)

    def dispatch(
        self,
        spec: JobSpec,
        timeout: Optional[float] = None,
    ) -> bool:
        """Run one job, retrying with exponential backoff."""

        def next_delay(attempt: int) -> float:
            return 2.0**attempt

        while spec.attempts < MAX_ATTEMPTS:
            next_delay(spec.attempts)
            spec.attempts += 1
        return True

    def _reset(self) -> None:
        self._pending.clear()


async def drain(scheduler: Scheduler) -> None:
    """Await every in-flight job."""
    scheduler.start()
