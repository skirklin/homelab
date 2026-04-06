"""Tests for shared ingest parsers using real captured data.

Each test creates a fresh DB, runs a parser against real raw captures,
and verifies the parser produces the correct records. These tests serve
as the safety net for tightening error handling — if a test passes, the
parser correctly handles the real data format.
"""

import re
from pathlib import Path

import pytest

from money.config import DATA_DIR
from money.db import Database

RAW_DIR = DATA_DIR / "raw"
TS_RE = re.compile(r"^(\d{8}_\d{6})_")


@pytest.fixture
def db(tmp_path: Path) -> Database:
    """Create a fresh database for each test."""
    d = Database(str(tmp_path / "test.db"))
    d.initialize()
    return d


def _find_login_dir(institution: str) -> Path:
    """Find the first login subdirectory for an institution."""
    inst_dir = RAW_DIR / institution
    if not inst_dir.exists():
        pytest.skip(f"No {institution} raw data")
    for d in sorted(inst_dir.iterdir()):
        if d.is_dir():
            return d
    pytest.skip(f"No {institution} login directories")
    return inst_dir  # unreachable


def _first_ts(institution: str, anchor: str) -> tuple[str, Path]:
    """Find the first available timestamp and its login dir for an institution."""
    inst_dir = RAW_DIR / institution
    if not inst_dir.exists():
        pytest.skip(f"No {institution} raw data")
    for login_dir in sorted(inst_dir.iterdir()):
        if not login_dir.is_dir():
            continue
        for f in sorted(login_dir.iterdir()):
            if anchor in f.name:
                m = TS_RE.match(f.name)
                if m:
                    return m.group(1), login_dir
    pytest.skip(f"No {institution} {anchor} files")
    return "", inst_dir  # unreachable


def _latest_ts(institution: str, anchor: str) -> tuple[str, Path]:
    """Find the latest available timestamp and its login dir for an institution."""
    inst_dir = RAW_DIR / institution
    if not inst_dir.exists():
        pytest.skip(f"No {institution} raw data")
    best_ts = ""
    best_dir = inst_dir
    for login_dir in sorted(inst_dir.iterdir()):
        if not login_dir.is_dir():
            continue
        for f in sorted(login_dir.iterdir()):
            if anchor in f.name:
                m = TS_RE.match(f.name)
                if m and m.group(1) > best_ts:
                    best_ts = m.group(1)
                    best_dir = login_dir
    if not best_ts:
        pytest.skip(f"No {institution} {anchor} files")
    return best_ts, best_dir


# ── Ally ──────────────────────────────────────────────────────────────


class TestAlly:
    def test_creates_accounts_with_profile(self, db: Database) -> None:
        from money.ingest.ally_api import parse_raw_ally

        ts, login_dir = _first_ts("ally", "accounts.json")
        parse_raw_ally(db, login_dir, ts, "scott@ally")

        accounts = [a for a in db.list_accounts() if a.institution == "ally"]
        assert len(accounts) >= 2  # at least Spending + Joint Checking
        for a in accounts:
            assert a.profile == "scott@ally"
            assert a.external_id is not None
            assert len(a.external_id) == 4  # last 4 digits

    def test_creates_balances(self, db: Database) -> None:
        from money.ingest.ally_api import parse_raw_ally

        ts, login_dir = _latest_ts("ally", "accounts.json")
        parse_raw_ally(db, login_dir, ts, "scott@ally")

        balances = db.conn.execute("SELECT COUNT(*) FROM balances").fetchone()[0]
        assert balances > 0

    def test_creates_transactions(self, db: Database) -> None:
        from money.ingest.ally_api import parse_raw_ally

        ts, login_dir = _latest_ts("ally", "accounts.json")
        parse_raw_ally(db, login_dir, ts, "scott@ally")

        txns = db.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        assert txns > 100  # hundreds of transactions expected

    def test_skips_external_accounts(self, db: Database) -> None:
        from money.ingest.ally_api import parse_raw_ally

        ts, login_dir = _first_ts("ally", "accounts.json")
        parse_raw_ally(db, login_dir, ts, "scott@ally")

        for a in db.list_accounts():
            assert a.institution == "ally"

    def test_dedup_on_reparse(self, db: Database) -> None:
        from money.ingest.ally_api import parse_raw_ally

        ts, login_dir = _latest_ts("ally", "accounts.json")
        parse_raw_ally(db, login_dir, ts, "scott@ally")
        count1 = db.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]

        parse_raw_ally(db, login_dir, ts, "scott@ally")
        count2 = db.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]

        assert count1 == count2


# ── Betterment ────────────────────────────────────────────────────────


class TestBetterment:
    def test_creates_accounts_with_profile(self, db: Database) -> None:
        from money.ingest.betterment import parse_raw_betterment

        ts, login_dir = _first_ts("betterment", "sidebar.json")
        parse_raw_betterment(db, login_dir, ts, "scott@betterment")

        accounts = [a for a in db.list_accounts() if a.institution == "betterment"]
        assert len(accounts) >= 3  # multiple investment accounts
        for a in accounts:
            assert a.profile == "scott@betterment"

    def test_creates_balances(self, db: Database) -> None:
        from money.ingest.betterment import parse_raw_betterment

        ts, login_dir = _latest_ts("betterment", "sidebar.json")
        parse_raw_betterment(db, login_dir, ts, "scott@betterment")

        balances = db.conn.execute("SELECT COUNT(*) FROM balances").fetchone()[0]
        assert balances > 0

    def test_creates_performance_history(self, db: Database) -> None:
        from money.ingest.betterment import parse_raw_betterment

        ts, login_dir = _latest_ts("betterment", "sidebar.json")
        parse_raw_betterment(db, login_dir, ts, "scott@betterment")

        perf = db.conn.execute("SELECT COUNT(*) FROM performance_history").fetchone()[0]
        assert perf > 100  # years of daily data

    def test_creates_holdings(self, db: Database) -> None:
        from money.ingest.betterment import parse_raw_betterment

        ts, login_dir = _latest_ts("betterment", "sidebar.json")
        parse_raw_betterment(db, login_dir, ts, "scott@betterment")

        holdings = db.conn.execute("SELECT COUNT(*) FROM holdings").fetchone()[0]
        assert holdings > 10  # multiple positions across accounts

    def test_disambiguates_account_names(self, db: Database) -> None:
        from money.ingest.betterment import parse_raw_betterment

        ts, login_dir = _latest_ts("betterment", "sidebar.json")
        parse_raw_betterment(db, login_dir, ts, "scott@betterment")

        names = [a.name for a in db.list_accounts() if a.institution == "betterment"]
        # Should not have duplicate names (ESG vs Smart Beta should be distinct)
        assert len(names) == len(set(names)), f"Duplicate account names: {names}"


# ── Wealthfront ───────────────────────────────────────────────────────


class TestWealthfront:
    def test_creates_accounts_with_profile(self, db: Database) -> None:
        from money.ingest.wealthfront import parse_raw_wealthfront

        ts, login_dir = _first_ts("wealthfront", "overviews.json")
        parse_raw_wealthfront(db, login_dir, ts, "scott@wealthfront")

        accounts = [a for a in db.list_accounts() if a.institution == "wealthfront"]
        assert len(accounts) >= 1
        for a in accounts:
            assert a.profile == "scott@wealthfront"

    def test_creates_balances(self, db: Database) -> None:
        from money.ingest.wealthfront import parse_raw_wealthfront

        ts, login_dir = _latest_ts("wealthfront", "overviews.json")
        parse_raw_wealthfront(db, login_dir, ts, "scott@wealthfront")

        balances = db.conn.execute("SELECT COUNT(*) FROM balances").fetchone()[0]
        assert balances > 0

    def test_creates_performance_history(self, db: Database) -> None:
        from money.ingest.wealthfront import parse_raw_wealthfront

        ts, login_dir = _latest_ts("wealthfront", "overviews.json")
        parse_raw_wealthfront(db, login_dir, ts, "scott@wealthfront")

        perf = db.conn.execute("SELECT COUNT(*) FROM performance_history").fetchone()[0]
        assert perf > 1000  # years of daily data

    def test_creates_holdings(self, db: Database) -> None:
        from money.ingest.wealthfront import parse_raw_wealthfront

        ts, login_dir = _latest_ts("wealthfront", "overviews.json")
        parse_raw_wealthfront(db, login_dir, ts, "scott@wealthfront")

        holdings = db.conn.execute("SELECT COUNT(*) FROM holdings").fetchone()[0]
        assert holdings > 5  # at least several positions

    def test_holdings_have_symbols(self, db: Database) -> None:
        from money.ingest.wealthfront import parse_raw_wealthfront

        ts, login_dir = _latest_ts("wealthfront", "overviews.json")
        parse_raw_wealthfront(db, login_dir, ts, "scott@wealthfront")

        null_symbols = db.conn.execute(
            "SELECT COUNT(*) FROM holdings WHERE symbol IS NULL"
        ).fetchone()[0]
        assert null_symbols == 0, "All Wealthfront holdings should have symbols"


# ── Capital One ───────────────────────────────────────────────────────


class TestCapitalOne:
    def test_creates_accounts_with_profile(self, db: Database) -> None:
        from money.ingest.capital_one import parse_raw_capital_one

        ts, login_dir = _first_ts("capital_one", "accounts.json")
        parse_raw_capital_one(db, login_dir, ts, "scott@capital_one")

        accounts = [a for a in db.list_accounts() if a.institution == "capital_one"]
        assert len(accounts) >= 1
        for a in accounts:
            assert a.profile == "scott@capital_one"
            assert a.account_type.value == "credit_card"

    def test_balances_are_negative(self, db: Database) -> None:
        from money.ingest.capital_one import parse_raw_capital_one

        ts, login_dir = _latest_ts("capital_one", "accounts.json")
        parse_raw_capital_one(db, login_dir, ts, "scott@capital_one")

        rows = db.conn.execute("SELECT balance FROM balances").fetchall()
        assert len(rows) > 0
        for r in rows:
            assert r[0] <= 0, "Credit card balances should be negative"

    def test_chunked_transactions(self, db: Database) -> None:
        from money.ingest.capital_one import parse_raw_capital_one

        # Find a timestamp with chunked files
        login_dir = _find_login_dir("capital_one")
        chunked_ts = None
        for f in sorted(login_dir.iterdir()):
            if "_transactions_1.json" in f.name:
                m = TS_RE.match(f.name)
                if m:
                    chunked_ts = m.group(1)
                    break
        if not chunked_ts:
            pytest.skip("No chunked transaction files")

        parse_raw_capital_one(db, login_dir, chunked_ts, "scott@capital_one")
        txns = db.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        assert txns > 500  # chunked = lots of transactions

    def test_dedup_on_reparse(self, db: Database) -> None:
        from money.ingest.capital_one import parse_raw_capital_one

        ts, login_dir = _latest_ts("capital_one", "accounts.json")
        parse_raw_capital_one(db, login_dir, ts, "scott@capital_one")
        count1 = db.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]

        parse_raw_capital_one(db, login_dir, ts, "scott@capital_one")
        count2 = db.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        assert count1 == count2


# ── Chase ─────────────────────────────────────────────────────────────


class TestChase:
    def test_creates_accounts_with_profile(self, db: Database) -> None:
        from money.ingest.chase import parse_raw_chase

        ts, login_dir = _first_ts("chase", "network_log.json")
        parse_raw_chase(db, login_dir, ts, "angela@chase")

        accounts = [a for a in db.list_accounts() if a.institution == "chase"]
        assert len(accounts) >= 2  # checking + trust
        for a in accounts:
            assert a.profile == "angela@chase"

    def test_creates_balances(self, db: Database) -> None:
        from money.ingest.chase import parse_raw_chase

        ts, login_dir = _first_ts("chase", "network_log.json")
        parse_raw_chase(db, login_dir, ts, "angela@chase")

        balances = db.conn.execute("SELECT COUNT(*) FROM balances").fetchone()[0]
        assert balances > 0

    def test_creates_transactions(self, db: Database) -> None:
        from money.ingest.chase import parse_raw_chase

        ts, login_dir = _first_ts("chase", "network_log.json")
        parse_raw_chase(db, login_dir, ts, "angela@chase")

        txns = db.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        assert txns > 10


# ── Morgan Stanley ────────────────────────────────────────────────────


class TestMorganStanley:
    def test_creates_account_with_profile(self, db: Database) -> None:
        from money.ingest.morgan_stanley import parse_raw_morgan_stanley

        ts, login_dir = _first_ts("morgan_stanley", "portfolio_summary.json")
        parse_raw_morgan_stanley(db, login_dir, ts, "scott@morgan_stanley")

        accounts = [a for a in db.list_accounts() if a.institution == "morgan_stanley"]
        assert len(accounts) == 1
        assert accounts[0].profile == "scott@morgan_stanley"
        assert accounts[0].account_type.value == "stock_options"

    def test_creates_exactly_12_grants(self, db: Database) -> None:
        from money.ingest.morgan_stanley import parse_raw_morgan_stanley

        ts, login_dir = _first_ts("morgan_stanley", "portfolio_summary.json")
        parse_raw_morgan_stanley(db, login_dir, ts, "scott@morgan_stanley")

        count = db.conn.execute("SELECT COUNT(*) FROM option_grants").fetchone()[0]
        assert count == 12

    def test_grants_have_stable_ids(self, db: Database) -> None:
        from money.ingest.morgan_stanley import parse_raw_morgan_stanley

        ts, login_dir = _first_ts("morgan_stanley", "portfolio_summary.json")
        parse_raw_morgan_stanley(db, login_dir, ts, "scott@morgan_stanley")

        ids = [r[0] for r in db.conn.execute("SELECT id FROM option_grants").fetchall()]
        # IDs should be grant numbers like "ES-0414", not random UUIDs
        for grant_id in ids:
            assert not grant_id.count("-") > 2, f"Grant ID looks like UUID: {grant_id}"

    def test_grant_dedup_on_reparse(self, db: Database) -> None:
        from money.ingest.morgan_stanley import parse_raw_morgan_stanley

        ts, login_dir = _first_ts("morgan_stanley", "portfolio_summary.json")
        parse_raw_morgan_stanley(db, login_dir, ts, "scott@morgan_stanley")
        parse_raw_morgan_stanley(db, login_dir, ts, "scott@morgan_stanley")

        count = db.conn.execute("SELECT COUNT(*) FROM option_grants").fetchone()[0]
        assert count == 12  # no duplicates

    def test_vested_shares_from_portfolio_summary(self, db: Database) -> None:
        from money.ingest.morgan_stanley import parse_raw_morgan_stanley

        ts, login_dir = _first_ts("morgan_stanley", "portfolio_summary.json")
        parse_raw_morgan_stanley(db, login_dir, ts, "scott@morgan_stanley")

        # NQ split grant should have ~94,550 vested from MS dashboard
        row = db.conn.execute(
            "SELECT vested_shares FROM option_grants WHERE id = 'ES-0414Split'"
        ).fetchone()
        assert row is not None
        assert row[0] > 90000

    def test_creates_balance(self, db: Database) -> None:
        from money.ingest.morgan_stanley import parse_raw_morgan_stanley

        ts, login_dir = _first_ts("morgan_stanley", "portfolio_summary.json")
        parse_raw_morgan_stanley(db, login_dir, ts, "scott@morgan_stanley")

        balances = db.conn.execute("SELECT COUNT(*) FROM balances").fetchone()[0]
        assert balances > 0

    def test_creates_fmv_valuation(self, db: Database) -> None:
        from money.ingest.morgan_stanley import parse_raw_morgan_stanley

        ts, login_dir = _first_ts("morgan_stanley", "portfolio_summary.json")
        parse_raw_morgan_stanley(db, login_dir, ts, "scott@morgan_stanley")

        fmv = db.conn.execute(
            "SELECT fmv_per_share FROM private_valuations"
        ).fetchone()
        assert fmv is not None
        assert fmv[0] > 100  # 409A FMV should be substantial


# ── Replay consistency ────────────────────────────────────────────────


class TestReplay:
    def test_produces_accounts_with_profiles(self, tmp_path: Path) -> None:
        from money.replay import replay_all

        replay_all(str(tmp_path / "replay.db"), RAW_DIR)
        replay_db = Database(str(tmp_path / "replay.db"))

        accounts = replay_db.list_accounts()
        assert len(accounts) > 10  # should have many accounts

        for a in accounts:
            assert a.profile is not None, f"Account {a.name} missing profile"

        replay_db.close()

    def test_no_duplicate_grants(self, tmp_path: Path) -> None:
        from money.replay import replay_all

        replay_all(str(tmp_path / "replay.db"), RAW_DIR)
        replay_db = Database(str(tmp_path / "replay.db"))

        total = replay_db.conn.execute("SELECT COUNT(*) FROM option_grants").fetchone()[0]
        unique = replay_db.conn.execute(
            "SELECT COUNT(DISTINCT id) FROM option_grants"
        ).fetchone()[0]
        assert total == unique
        assert total == 12

        replay_db.close()

    def test_all_institutions_have_data(self, tmp_path: Path) -> None:
        from money.replay import replay_all

        replay_all(str(tmp_path / "replay.db"), RAW_DIR)
        replay_db = Database(str(tmp_path / "replay.db"))

        institutions = {
            r[0] for r in
            replay_db.conn.execute(
                "SELECT DISTINCT institution FROM accounts"
            ).fetchall()
        }
        expected = {"ally", "betterment", "wealthfront", "capital_one", "chase", "morgan_stanley"}
        assert institutions == expected, f"Missing: {expected - institutions}"

        replay_db.close()
