"""Shared helpers for ingest modules."""

from datetime import date


def ts_to_date(ts: str) -> date:
    """Convert a YYYYMMDD_HHMMSS timestamp to a date."""
    return date(int(ts[:4]), int(ts[4:6]), int(ts[6:8]))
