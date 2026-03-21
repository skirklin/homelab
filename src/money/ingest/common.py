"""Shared helpers for ingest modules."""

import json
from datetime import date
from pathlib import Path
from typing import Any


def ts_to_date(ts: str) -> date:
    """Convert a YYYYMMDD_HHMMSS timestamp to a date."""
    return date(int(ts[:4]), int(ts[4:6]), int(ts[6:8]))


def read_json(path: Path) -> Any:
    """Read and parse a JSON file, or return None if missing."""
    if not path.exists():
        return None
    return json.loads(path.read_text())
