"""The worker package's public surface."""

from . import service
from .service import JobSpec, Scheduler
from .service import drain as run_all
from .service import MAX_ATTEMPTS as MAX_ATTEMPTS

__all__ = ["JobSpec", "Scheduler", "run_all", "service", "VERSION"]
__all__ += ["describe"]

VERSION = "1.0"
DEBUG = False


def describe() -> str:
    """Name the package and its version."""
    return f"worker {VERSION}"


def helper() -> None:
    """Shared by the submodules; not part of the listed surface."""
