"""Atomic, validated read/write of money's `config.json`.

Kept separate from `config.py` so the load path stays slim and the write path
can carry its own dependencies (diffing, dotted-path mutation, backup
rotation).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from money.config import AppConfig, InstitutionConfig, LoginConfig, PersonConfig

_BACKUP_KEEP = 5


class ConfigValidationError(Exception):
    """Raised when a proposed config dict doesn't pass validation."""


class ConfigPathError(Exception):
    """Raised when a dotted/bracketed path can't be parsed or resolved."""


def parse_path(path: str) -> list[str]:
    """Tokenize a config path like `logins["scott@ally"].username`.

    Bracket form `[...]` is required for any key that contains `.` or `@`.
    Bare-segment dotted paths are split on `.` only when no segment contains
    those metacharacters.
    """
    # Tokenize: dotted segments OR [bracketed] segments. Bracket form supports
    # both quoted and unquoted contents.
    tokens: list[str] = []
    i = 0
    n = len(path)
    while i < n:
        ch = path[i]
        if ch == ".":
            i += 1
            continue
        if ch == "[":
            end = path.find("]", i)
            if end == -1:
                raise ConfigPathError(f"Unclosed bracket in path: {path!r}")
            inner = path[i + 1 : end]
            # Strip optional matching quotes.
            if len(inner) >= 2 and inner[0] == inner[-1] and inner[0] in ('"', "'"):
                inner = inner[1:-1]
            if not inner:
                raise ConfigPathError(f"Empty bracket segment in path: {path!r}")
            tokens.append(inner)
            i = end + 1
            continue
        # Read a bare segment up to the next `.` or `[`.
        j = i
        while j < n and path[j] not in (".", "["):
            j += 1
        seg = path[i:j]
        if not seg:
            raise ConfigPathError(f"Empty segment in path: {path!r}")
        # If the bare segment contains `@` reject it — the user almost
        # certainly meant the bracket form.
        if "@" in seg:
            raise ConfigPathError(
                f"Ambiguous segment {seg!r} in path {path!r}: use bracket form, "
                f'e.g. logins["{seg}"].username'
            )
        tokens.append(seg)
        i = j
    if not tokens:
        raise ConfigPathError(f"Empty path: {path!r}")
    return tokens


def get_value(raw: dict[str, Any], path: str) -> object:
    """Resolve a dotted/bracketed path against `raw`. Raises ConfigPathError on miss."""
    tokens = parse_path(path)
    cur: object = raw
    for tok in tokens:
        if isinstance(cur, dict):
            if tok not in cur:
                raise ConfigPathError(f"Key not found: {tok!r} (in path {path!r})")
            cur = cur[tok]
        elif isinstance(cur, list):
            try:
                idx = int(tok)
            except ValueError:
                raise ConfigPathError(
                    f"List index must be an integer, got {tok!r} (in path {path!r})"
                ) from None
            if idx < 0 or idx >= len(cur):
                raise ConfigPathError(f"Index {idx} out of range (in path {path!r})")
            cur = cur[idx]
        else:
            raise ConfigPathError(
                f"Cannot descend into {type(cur).__name__} at {tok!r} (path {path!r})"
            )
    return cur


def set_value(raw: dict[str, Any], path: str, value: object) -> None:
    """Mutate `raw` in-place: set the leaf at `path` to `value`.

    Intermediate dict containers are created as needed; leaf-into-list isn't
    supported (raises ConfigPathError).
    """
    tokens = parse_path(path)
    cur: object = raw
    for tok in tokens[:-1]:
        if isinstance(cur, dict):
            if tok not in cur or not isinstance(cur[tok], dict):
                cur[tok] = {}
            cur = cur[tok]
        elif isinstance(cur, list):
            try:
                idx = int(tok)
            except ValueError:
                raise ConfigPathError(
                    f"List index must be an integer, got {tok!r} (in path {path!r})"
                ) from None
            if idx < 0 or idx >= len(cur):
                raise ConfigPathError(f"Index {idx} out of range (in path {path!r})")
            cur = cur[idx]
        else:
            raise ConfigPathError(
                f"Cannot descend into {type(cur).__name__} at {tok!r} (path {path!r})"
            )
    leaf = tokens[-1]
    if isinstance(cur, dict):
        cur[leaf] = value
    elif isinstance(cur, list):
        try:
            idx = int(leaf)
        except ValueError:
            raise ConfigPathError(
                f"List index must be an integer, got {leaf!r} (in path {path!r})"
            ) from None
        if idx < 0 or idx >= len(cur):
            raise ConfigPathError(f"Index {idx} out of range (in path {path!r})")
        cur[idx] = value
    else:
        raise ConfigPathError(
            f"Cannot set leaf on {type(cur).__name__} at {leaf!r} (path {path!r})"
        )


def coerce_scalar(text: str) -> object:
    """Best-effort coercion of a CLI-provided value: JSON-first, then string."""
    s = text.strip()
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return text


def _validate(raw: dict[str, Any]) -> None:
    """Round-trip `raw` through the AppConfig dataclasses; raise on mismatch."""
    try:
        institutions = {
            k: InstitutionConfig(label=v.get("label", k), url=v.get("url"))
            for k, v in raw.get("institutions", {}).items()
        }
        people = {
            k: PersonConfig(name=v.get("name", k))
            for k, v in raw.get("people", {}).items()
        }
        logins = {
            k: LoginConfig(
                person=v["person"],
                institution=v["institution"],
                username=v.get("username"),
            )
            for k, v in raw.get("logins", {}).items()
        }
    except KeyError as e:
        raise ConfigValidationError(f"Missing required field: {e.args[0]!r}") from e
    except TypeError as e:
        raise ConfigValidationError(f"Type error during validation: {e}") from e

    # FK validation: each login.person must exist in people; each
    # login.institution must exist in institutions.
    for login_id, lc in logins.items():
        if lc.person not in people:
            raise ConfigValidationError(
                f"login {login_id!r} references unknown person {lc.person!r}; "
                f"add people.{lc.person} first"
            )
        if lc.institution not in institutions:
            raise ConfigValidationError(
                f"login {login_id!r} references unknown institution {lc.institution!r}; "
                f"add institutions.{lc.institution} first"
            )

    # Cheap final sanity-check: dataclass round-trip.
    _ = AppConfig(institutions=institutions, people=people, logins=logins)


def serialize(raw: dict[str, Any]) -> str:
    """Pretty-print the config in the canonical on-disk form."""
    return json.dumps(raw, indent=2, sort_keys=True) + "\n"


def load_raw(path: Path) -> dict[str, Any]:
    """Load the config file as a raw dict (bypassing AppConfig default-fill)."""
    if not path.exists():
        raise ConfigValidationError(f"Config file does not exist: {path}")
    return json.loads(path.read_text())


def atomic_write(path: Path, serialized: str) -> None:
    """Write `serialized` to `path` atomically (same-fs tmp + os.replace + fsync).

    Tmp file MUST live in `path`'s directory — `os.replace` is only atomic on
    the same filesystem.
    """
    tmp = path.parent / f".{path.name}.tmp.{os.getpid()}"
    try:
        with open(tmp, "w") as f:
            f.write(serialized)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


_BACKUP_RE = re.compile(r"\.bak\.\d{8}_\d{6}$")


def write_backup(path: Path, original_text: str) -> Path:
    """Copy `original_text` to a timestamped sibling and rotate older backups."""
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = path.parent / f"{path.name}.bak.{ts}"
    backup.write_text(original_text)
    _rotate_backups(path)
    return backup


def _rotate_backups(path: Path) -> None:
    """Keep at most `_BACKUP_KEEP` backups; delete the rest (oldest first)."""
    siblings = sorted(
        (
            p
            for p in path.parent.iterdir()
            if p.is_file()
            and p.name.startswith(f"{path.name}.bak.")
            and _BACKUP_RE.search(p.name)
        ),
        key=lambda p: p.name,
    )
    excess = len(siblings) - _BACKUP_KEEP
    for old in siblings[: max(0, excess)]:
        try:
            old.unlink()
        except OSError:
            pass


@dataclass
class WriteResult:
    """Summary of a successful write."""

    backup: Path | None
    diff: str
    changed: list[str]


def _diff_lines(before: str, after: str, label: str) -> str:
    import difflib

    return "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"{label} (current)",
            tofile=f"{label} (proposed)",
        )
    )


def apply_mutation(
    path: Path,
    mutate: "callable",  # type: ignore[valid-type]
    *,
    dry_run: bool = False,
) -> WriteResult:
    """Apply an in-memory mutation and persist atomically with a backup.

    `mutate(raw)` is called with a fresh deep copy of the parsed config; it
    should mutate in place. Returns a WriteResult with the diff text + backup
    path (None on no-op or dry-run).
    """
    import copy

    original_text = path.read_text() if path.exists() else "{}\n"
    raw = json.loads(original_text) if original_text.strip() else {}
    proposed = copy.deepcopy(raw)
    mutate(proposed)
    _validate(proposed)
    after_text = serialize(proposed)

    diff = _diff_lines(serialize(raw) if raw else original_text, after_text, path.name)

    changed = _diff_keys(raw, proposed)

    if not diff:
        return WriteResult(backup=None, diff="", changed=[])

    if dry_run:
        return WriteResult(backup=None, diff=diff, changed=changed)

    backup = write_backup(path, original_text) if path.exists() else None
    atomic_write(path, after_text)
    return WriteResult(backup=backup, diff=diff, changed=changed)


def _diff_keys(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """Return a sorted list of dotted paths that changed between before/after."""
    changed: set[str] = set()

    def walk(b: object, a: object, prefix: str) -> None:
        if isinstance(b, dict) and isinstance(a, dict):
            keys = set(b.keys()) | set(a.keys())
            for k in keys:
                bv = b.get(k)
                av = a.get(k)
                path = f"{prefix}.{k}" if prefix else k
                if k not in b or k not in a:
                    changed.add(path)
                else:
                    walk(bv, av, path)
        elif b != a:
            changed.add(prefix or "<root>")

    walk(before, after, "")
    return sorted(changed)
