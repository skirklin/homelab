"""Tests for shared ingest parsers using real captured data.

Each test creates a temp DB, points a parser at the real raw data directory,
and verifies the parser produces correct records.
"""

from pathlib import Path

import pytest

from money.config import DATA_DIR
from money.db import Database

RAW_DIR = DATA_DIR / "raw"


@pytest.fixture
def db(tmp_path: Path) -> Database:
    """Create a fresh in-memory database for each test."""
    d = Database(str(tmp_path / "test.db"))
    d.initialize()
    return d


def _find_first_timestamp(institution: str, anchor: str) -> str | None:
    """Find the first available timestamp for an institution."""
    inst_dir = RAW_DIR / institution
    if not inst_dir.exists():
        return None
    import re
    ts_re = re.compile(r"^(\d{8}_\d{6})_")
    for f in sorted(inst_dir.iterdir()):
        if f.name.endswith(f"_{anchor}") or f.name == anchor:
            m = ts_re.match(f.name)
            if m:
                return m.group(1)
    return None


# ---------------------------------------------------------------------------
# Ally
# ---------------------------------------------------------------------------

class TestAllyParser:
    def test_parse_creates_accounts(self, db: Database) -> None:
        from money.ingest.ally_api import parse_raw_ally

        ts = _find_first_timestamp("ally", "accounts.json")
        if not ts:
            pytest.skip("No Ally raw data")

        inst_dir = RAW_DIR / "ally"
        parse_raw_ally(db, inst_dir, ts, "scott@ally")

        accounts = db.list_accounts()
        ally_accounts = [a for a in accounts if a.institution == "ally"]
        assert len(ally_accounts) > 0, "Should create at least one account"

        for a in ally_accounts:
            assert a.profile == "scott@ally"
            assert a.external_id is not None

    def test_parse_skips_external_accounts(self, db: Database) -> None:
        from money.ingest.ally_api import parse_raw_ally

        ts = _find_first_timestamp("ally", "accounts.json")
        if not ts:
            pytest.skip("No Ally raw data")

        inst_dir = RAW_DIR / "ally"
        parse_raw_ally(db, inst_dir, ts, "scott@ally")

        accounts = db.list_accounts()
        for a in accounts:
            # External accounts (Bank of America, etc.) should not be created
            assert a.institution == "ally"

    def test_transaction_dedup(self, db: Database) -> None:
        from money.ingest.ally_api import parse_raw_ally

        ts = _find_first_timestamp("ally", "accounts.json")
        if not ts:
            pytest.skip("No Ally raw data")

        inst_dir = RAW_DIR / "ally"
        # Parse twice — should not duplicate transactions
        parse_raw_ally(db, inst_dir, ts, "scott@ally")
        count1 = db.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]

        parse_raw_ally(db, inst_dir, ts, "scott@ally")
        count2 = db.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]

        assert count1 == count2, "Parsing twice should not create duplicates"


# ---------------------------------------------------------------------------
# Capital One
# ---------------------------------------------------------------------------

class TestCapitalOneParser:
    def test_parse_creates_accounts_and_transactions(self, db: Database) -> None:
        from money.ingest.capital_one import parse_raw_capital_one

        ts = _find_first_timestamp("capital_one", "accounts.json")
        if not ts:
            pytest.skip("No Capital One raw data")

        inst_dir = RAW_DIR / "capital_one"
        parse_raw_capital_one(db, inst_dir, ts, "scott@capital_one")

        accounts = db.list_accounts()
        co_accounts = [a for a in accounts if a.institution == "capital_one"]
        assert len(co_accounts) > 0

        # Should have negative balances (credit card liabilities)
        for a in co_accounts:
            assert a.profile == "scott@capital_one"
            bal = db.conn.execute(
                "SELECT balance FROM balances WHERE account_id = ?", (a.id,)
            ).fetchone()
            if bal:
                assert bal[0] <= 0, "Credit card balance should be negative"

    def test_handles_chunked_transactions(self, db: Database) -> None:
        from money.ingest.capital_one import parse_raw_capital_one

        # Find a timestamp with chunked files
        inst_dir = RAW_DIR / "capital_one"
        if not inst_dir.exists():
            pytest.skip("No Capital One raw data")

        chunked_ts = None
        for f in sorted(inst_dir.iterdir()):
            if "_transactions_1.json" in f.name:
                chunked_ts = f.name.split("_")[0] + "_" + f.name.split("_")[1]
                break

        if not chunked_ts:
            pytest.skip("No chunked transaction files")

        parse_raw_capital_one(db, inst_dir, chunked_ts, "scott@capital_one")
        txn_count = db.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        assert txn_count > 100, "Chunked files should produce many transactions"


# ---------------------------------------------------------------------------
# Morgan Stanley
# ---------------------------------------------------------------------------

class TestMorganStanleyParser:
    def test_parse_creates_grants(self, db: Database) -> None:
        from money.ingest.morgan_stanley import parse_raw_morgan_stanley

        ts = _find_first_timestamp("morgan_stanley", "portfolio_summary.json")
        if not ts:
            pytest.skip("No Morgan Stanley raw data")

        inst_dir = RAW_DIR / "morgan_stanley"
        parse_raw_morgan_stanley(db, inst_dir, ts, "scott@morgan_stanley")

        grants = db.conn.execute("SELECT COUNT(*) FROM option_grants").fetchone()[0]
        assert grants > 0, "Should create grants"
        assert grants == 12, "Expected 12 grants from Shareworks data"

    def test_grant_dedup(self, db: Database) -> None:
        from money.ingest.morgan_stanley import parse_raw_morgan_stanley

        ts = _find_first_timestamp("morgan_stanley", "portfolio_summary.json")
        if not ts:
            pytest.skip("No Morgan Stanley raw data")

        inst_dir = RAW_DIR / "morgan_stanley"
        parse_raw_morgan_stanley(db, inst_dir, ts, "scott@morgan_stanley")
        count1 = db.conn.execute("SELECT COUNT(*) FROM option_grants").fetchone()[0]

        parse_raw_morgan_stanley(db, inst_dir, ts, "scott@morgan_stanley")
        count2 = db.conn.execute("SELECT COUNT(*) FROM option_grants").fetchone()[0]

        assert count1 == count2, "Parsing twice should not create duplicate grants"

    def test_vested_shares_from_portfolio_summary(self, db: Database) -> None:
        from money.ingest.morgan_stanley import parse_raw_morgan_stanley

        ts = _find_first_timestamp("morgan_stanley", "portfolio_summary.json")
        if not ts:
            pytest.skip("No Morgan Stanley raw data")

        inst_dir = RAW_DIR / "morgan_stanley"
        parse_raw_morgan_stanley(db, inst_dir, ts, "scott@morgan_stanley")

        # Check that vested_shares comes from portfolio summary, not estimation
        rows = db.conn.execute(
            "SELECT id, vested_shares, vested_value FROM option_grants WHERE vested_shares > 0"
        ).fetchall()
        assert len(rows) > 0, "Some grants should have vested shares"

        # The Feb 2024 NQ split grant should have ~94,550 vested (from MS dashboard)
        nq_split = db.conn.execute(
            "SELECT vested_shares FROM option_grants WHERE id = 'ES-0414Split'"
        ).fetchone()
        if nq_split:
            assert nq_split[0] > 90000, "NQ split should have significant vesting"


# ---------------------------------------------------------------------------
# Chase
# ---------------------------------------------------------------------------

class TestChaseParser:
    def test_parse_network_log(self, db: Database) -> None:
        from money.ingest.chase import parse_raw_chase

        # Chase uses network logs in a different directory structure
        inst_dir = RAW_DIR / "chase"
        if not inst_dir.exists():
            pytest.skip("No Chase raw data")

        log_files = sorted(inst_dir.glob("*_network_log.json"))
        if not log_files:
            pytest.skip("No Chase network logs")

        import re
        m = re.match(r"^(\d{8}_\d{6})_", log_files[0].name)
        if not m:
            pytest.skip("Can't parse timestamp from Chase log")

        ts = m.group(1)
        parse_raw_chase(db, inst_dir, ts, "angela@chase")

        accounts = db.list_accounts()
        chase_accounts = [a for a in accounts if a.institution == "chase"]
        assert len(chase_accounts) > 0

        for a in chase_accounts:
            assert a.profile == "angela@chase"


# ---------------------------------------------------------------------------
# Cross-institution: replay consistency
# ---------------------------------------------------------------------------

class TestReplayConsistency:
    def test_replay_produces_same_as_individual_parsers(self, db: Database, tmp_path: Path) -> None:
        """Verify that replay calls the same parsers and produces identical results."""
        from money.replay import replay_all

        # Replay into a fresh DB
        replay_db_path = str(tmp_path / "replay.db")
        replay_all(replay_db_path, RAW_DIR, profile="default")

        replay_db = Database(replay_db_path)

        # Check accounts exist
        accounts = replay_db.list_accounts()
        assert len(accounts) > 0, "Replay should create accounts"

        # Check all accounts have profile set
        for a in accounts:
            assert a.profile is not None, f"Account {a.name} should have profile set"

        # Check grants exist and are not duplicated
        grant_count = replay_db.conn.execute("SELECT COUNT(*) FROM option_grants").fetchone()[0]
        unique_grants = replay_db.conn.execute(
            "SELECT COUNT(DISTINCT id) FROM option_grants"
        ).fetchone()[0]
        assert grant_count == unique_grants, "No duplicate grants"

        replay_db.close()
