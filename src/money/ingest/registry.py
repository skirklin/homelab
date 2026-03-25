"""Institution registry — auto-discovers institution modules and provides metadata."""

import importlib
import logging
import pkgutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from money.db import Database

log = logging.getLogger(__name__)

SyncFn = Callable[..., None]
ParseFn = Callable[[Database, Path, str, "str | None"], "dict[str, int]"]
PostReplayFn = Callable[[Database, Path, str], Any]

# Modules that are not institution implementations
_SKIP_MODULES = {"common", "registry", "schemas", "base", "browser"}


@dataclass(frozen=True)
class InstitutionInfo:
    """Metadata about an institution's ingestion capabilities."""

    name: str
    dir_name: str
    sync_fn: SyncFn
    parse_fn: ParseFn
    anchor_file: str
    display_name: str = ""
    post_replay_fn: PostReplayFn | None = None
    playwright_sync: bool = False  # requires Playwright login, not cookie/network-log auto-sync


_registry: dict[str, InstitutionInfo] = {}
_discovered = False


def register(info: InstitutionInfo) -> None:
    """Register an institution."""
    _registry[info.name] = info


def get(name: str) -> InstitutionInfo:
    """Get info for a registered institution."""
    _discover()
    if name not in _registry:
        raise KeyError(f"Unknown institution: {name}. Known: {sorted(_registry.keys())}")
    return _registry[name]


def all_institutions() -> list[InstitutionInfo]:
    """Return all registered institutions, sorted by name."""
    _discover()
    return sorted(_registry.values(), key=lambda i: i.name)


def _discover() -> None:
    """Auto-discover institution modules under money.ingest that export INSTITUTION."""
    global _discovered
    if _discovered:
        return
    _discovered = True

    import money.ingest as pkg

    for _finder, mod_name, is_pkg in pkgutil.iter_modules(pkg.__path__, pkg.__name__ + "."):
        if is_pkg:
            continue
        short_name = mod_name.split(".")[-1]
        if short_name in _SKIP_MODULES:
            continue
        try:
            mod = importlib.import_module(mod_name)
        except Exception:
            log.warning("Failed to import %s", mod_name, exc_info=True)
            continue
        info = getattr(mod, "INSTITUTION", None)
        if isinstance(info, InstitutionInfo):
            register(info)
