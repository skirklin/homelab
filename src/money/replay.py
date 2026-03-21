"""Replay ingestion from raw captures — rebuilds the database from stored API responses."""

import logging
import re
from datetime import date
from pathlib import Path

from money.db import Database
from money.models import IngestionRecord, IngestionStatus

log = logging.getLogger(__name__)

_TS_RE = re.compile(r"^(\d{8}_\d{6})_")


def _find_timestamps(raw_dir: Path, institution: str, anchor: str) -> list[str]:
    """Find all sync timestamps for an institution that have the anchor file.

    Returns timestamps sorted oldest-first.
    """
    inst_dir = raw_dir / institution
    if not inst_dir.exists():
        return []
    timestamps: set[str] = set()
    for f in inst_dir.iterdir():
        if f.name.endswith(f"_{anchor}") or f.name == anchor:
            m = _TS_RE.match(f.name)
            if m:
                timestamps.add(m.group(1))
    return sorted(timestamps)


def _ts_to_date(ts: str) -> date:
    """Convert a YYYYMMDD_HHMMSS timestamp to a date."""
    return date(int(ts[:4]), int(ts[4:6]), int(ts[6:8]))


def replay_all(db_path: str, raw_dir: Path, profile: str = "default") -> None:
    """Delete and rebuild the database from raw captures."""
    db_file = Path(db_path)
    if db_file.exists():
        db_file.unlink()
        log.info("Deleted existing database: %s", db_path)
    # Also clean up WAL/SHM files
    for suffix in ("-wal", "-shm"):
        wal = db_file.with_name(db_file.name + suffix)
        if wal.exists():
            wal.unlink()

    db = Database(db_path)
    db.initialize()
    log.info("Initialized fresh database: %s", db_path)

    try:
        _replay_ally(db, raw_dir, profile)
        _replay_betterment(db, raw_dir, profile)
        _replay_wealthfront(db, raw_dir, profile)
        _replay_capital_one(db, raw_dir, profile)
        _replay_chase(db, raw_dir, profile)
        _replay_morgan_stanley(db, raw_dir, profile)

        from money.benchmarks import enrich_holdings_asset_classes
        from money.categorize import apply_rules

        enriched = enrich_holdings_asset_classes(db)
        log.info("Enriched %d holdings.", enriched)
        tagged = apply_rules(db)
        log.info("Categorized %d transactions.", tagged)
    finally:
        db.close()

    log.info("Replay complete.")


def _replay_ally(db: Database, raw_dir: Path, profile: str) -> None:
    """Replay all Ally snapshots from raw captures."""
    from money.ingest.ally_api import parse_raw_ally, parse_raw_ally_extension

    inst_dir = raw_dir / "ally"
    if not inst_dir.exists():
        log.info("No Ally raw data found, skipping.")
        return

    timestamps = _find_timestamps(raw_dir, "ally", "accounts.json")
    if not timestamps:
        log.info("No Ally API snapshots found, skipping.")
    else:
        for ts in timestamps:
            parse_raw_ally(db, inst_dir, ts, profile)
            log.info("Replayed Ally snapshot %s", ts)

    # Extension captures are processed once, independent of API snapshots
    parse_raw_ally_extension(db, inst_dir, profile)

    db.insert_ingestion_record(
        IngestionRecord(
            source="ally",
            profile=profile,
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
        )
    )


def _replay_betterment(db: Database, raw_dir: Path, profile: str) -> None:
    """Replay all Betterment snapshots from raw captures."""
    from money.ingest.betterment import parse_raw_betterment

    timestamps = _find_timestamps(raw_dir, "betterment", "sidebar.json")
    if not timestamps:
        log.info("No Betterment raw data found, skipping.")
        return

    inst_dir = raw_dir / "betterment"
    for ts in timestamps:
        parse_raw_betterment(db, inst_dir, ts, profile)
        log.info("Replayed Betterment snapshot %s", ts)

    db.insert_ingestion_record(
        IngestionRecord(
            source="betterment",
            profile=profile,
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
        )
    )


def _replay_wealthfront(db: Database, raw_dir: Path, profile: str) -> None:
    """Replay all Wealthfront snapshots from raw captures."""
    from money.ingest.wealthfront import parse_raw_wealthfront

    timestamps = _find_timestamps(raw_dir, "wealthfront", "overviews.json")
    if not timestamps:
        log.info("No Wealthfront raw data found, skipping.")
        return

    inst_dir = raw_dir / "wealthfront"
    for ts in timestamps:
        parse_raw_wealthfront(db, inst_dir, ts, profile)
        log.info("Replayed Wealthfront snapshot %s", ts)

    db.insert_ingestion_record(
        IngestionRecord(
            source="wealthfront",
            profile=profile,
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
        )
    )


def _replay_capital_one(db: Database, raw_dir: Path, profile: str) -> None:
    """Replay all Capital One snapshots from raw captures."""
    from money.ingest.capital_one import parse_raw_capital_one

    timestamps = _find_timestamps(raw_dir, "capital_one", "accounts.json")
    if not timestamps:
        log.info("No Capital One raw data found, skipping.")
        return

    inst_dir = raw_dir / "capital_one"
    for ts in timestamps:
        parse_raw_capital_one(db, inst_dir, ts, profile)
        log.info("Replayed Capital One snapshot %s", ts)

    db.insert_ingestion_record(
        IngestionRecord(
            source="capital_one",
            profile=profile,
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
        )
    )


def _replay_chase(db: Database, raw_dir: Path, profile: str) -> None:
    """Replay all Chase network log snapshots from raw captures."""
    from money.ingest.chase import parse_raw_chase

    inst_dir = raw_dir / "chase"
    if not inst_dir.exists():
        log.info("No Chase raw data found, skipping.")
        return

    log_files = sorted(inst_dir.glob("*_network_log.json"))
    if not log_files:
        log.info("No Chase network logs found, skipping.")
        return

    for log_file in log_files:
        m = _TS_RE.match(log_file.name)
        if not m:
            continue
        ts = m.group(1)
        parse_raw_chase(db, inst_dir, ts, profile)
        log.info("Replayed Chase network log %s", ts)

    db.insert_ingestion_record(
        IngestionRecord(
            source="chase",
            profile=profile,
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
        )
    )


def _replay_morgan_stanley(db: Database, raw_dir: Path, profile: str) -> None:
    """Replay all Morgan Stanley snapshots from raw captures."""
    from money.ingest.morgan_stanley import parse_raw_morgan_stanley

    timestamps = _find_timestamps(raw_dir, "morgan_stanley", "portfolio_summary.json")
    if not timestamps:
        log.info("No Morgan Stanley raw data found, skipping.")
        return

    inst_dir = raw_dir / "morgan_stanley"
    for ts in timestamps:
        parse_raw_morgan_stanley(db, inst_dir, ts, profile)
        log.info("Replayed Morgan Stanley snapshot %s", ts)

    db.insert_ingestion_record(
        IngestionRecord(
            source="morgan_stanley",
            profile=profile,
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
        )
    )
