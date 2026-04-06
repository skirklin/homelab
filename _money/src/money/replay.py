"""Replay ingestion from raw captures — rebuilds the database from stored API responses."""

import logging
import re
from pathlib import Path

from money.db import Database
from money.ingest.registry import InstitutionInfo, all_institutions
from money.models import IngestionRecord, IngestionStatus

log = logging.getLogger(__name__)

_TS_RE = re.compile(r"^(\d{8}_\d{6})_")


def _find_timestamps(inst_dir: Path, anchor: str) -> list[str]:
    """Find all sync timestamps that have the anchor file. Sorted oldest-first."""
    if not inst_dir.exists():
        return []
    timestamps: set[str] = set()
    for f in inst_dir.iterdir():
        if f.name.endswith(f"_{anchor}"):
            m = _TS_RE.match(f.name)
            if m:
                timestamps.add(m.group(1))
    return sorted(timestamps)


def replay_all(db_path: str, raw_dir: Path) -> None:
    """Delete and rebuild the database from raw captures."""
    db_file = Path(db_path)
    if db_file.exists():
        db_file.unlink()
        log.info("Deleted existing database: %s", db_path)
    for suffix in ("-wal", "-shm"):
        wal = db_file.with_name(db_file.name + suffix)
        if wal.exists():
            wal.unlink()

    db = Database(db_path)
    db.initialize()
    log.info("Initialized fresh database: %s", db_path)

    try:
        for inst in all_institutions():
            _replay_institution(db, raw_dir, inst)

        from money.benchmarks import enrich_holdings_asset_classes
        from money.categorize import apply_rules

        enriched = enrich_holdings_asset_classes(db)
        log.info("Enriched %d holdings.", enriched)
        tagged = apply_rules(db)
        log.info("Categorized %d transactions.", tagged)
    finally:
        db.close()

    log.info("Replay complete.")


def _replay_institution(db: Database, raw_dir: Path, inst: InstitutionInfo) -> None:
    """Replay all snapshots for a single institution across all login profiles."""
    base_dir = raw_dir / inst.dir_name
    if not base_dir.exists():
        log.info("No %s raw data found, skipping.", inst.display_name or inst.name)
        return

    for login_dir in sorted(base_dir.iterdir()):
        if not login_dir.is_dir():
            continue
        login_id = login_dir.name

        timestamps = _find_timestamps(login_dir, inst.anchor_file)
        for ts in timestamps:
            inst.parse_fn(db, login_dir, ts, login_id)
            log.info("Replayed %s snapshot %s (%s)", inst.name, ts, login_id)

        if inst.post_replay_fn is not None:
            inst.post_replay_fn(db, login_dir, login_id)

        if timestamps:
            db.insert_ingestion_record(
                IngestionRecord(
                    source=inst.name,
                    profile=login_id,
                    status=IngestionStatus.SUCCESS,
                    raw_file_ref="replay",
                )
            )
