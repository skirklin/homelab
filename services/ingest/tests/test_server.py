"""Tests for the extension data receiver server."""

import json
import tempfile
from datetime import date, datetime, timedelta
from http.server import HTTPServer
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from money.db import Database
from money.models import AccountType
from money.server import IngestHandler
from money.storage import LocalStore


@pytest.fixture
def server_db():
    db = Database(":memory:", check_same_thread=False)
    db.initialize()
    yield db
    db.close()


@pytest.fixture
def server(server_db):
    with tempfile.TemporaryDirectory() as tmpdir:
        store = LocalStore(tmpdir)
        IngestHandler.db = server_db
        IngestHandler.store = store
        httpd = HTTPServer(("127.0.0.1", 0), IngestHandler)
        port = httpd.server_address[1]
        thread = Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        yield port, server_db, store
        httpd.shutdown()


def _post(port, path, data):
    body = json.dumps(data).encode()
    req = Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = urlopen(req)
    return json.loads(resp.read())


def _get(port, path):
    req = Request(f"http://127.0.0.1:{port}{path}", method="GET")
    resp = urlopen(req)
    return json.loads(resp.read())


def test_health_endpoint(server):
    port, _, _ = server
    result = _get(port, "/health")
    assert result["status"] == "ok"


def test_ingest_creates_accounts_and_balances(server):
    port, db, store = server
    payload = {
        "institution": "ally",
        "accounts": [
            {
                "name": "Checking",
                "account_type": "checking",
                "external_id": "1234",
                "balance": 5000.50,
            },
            {
                "name": "Savings",
                "account_type": "savings",
                "external_id": "5678",
                "balance": 10000.00,
            },
        ],
        "scraped_at": "2025-01-01T00:00:00Z",
    }
    result = _post(port, "/ingest", payload)

    assert result["status"] == "ok"
    assert result["accounts_synced"] == 2
    assert result["balances_recorded"] == 2

    # Verify accounts in DB
    accounts = db.list_accounts()
    assert len(accounts) == 2
    names = {a.name for a in accounts}
    assert names == {"Checking", "Savings"}

    # Verify balances
    for acct in accounts:
        bal = db.get_latest_balance(acct.id, date.today())
        assert bal is not None
        if acct.name == "Checking":
            assert bal.balance == 5000.50
        else:
            assert bal.balance == 10000.00
        assert bal.source == "ally_extension"

    # Verify raw data stored
    assert store.exists("ally/extension_" + result["raw_file_ref"].split("extension_")[1])


def test_ingest_without_balance(server):
    port, db, _ = server
    payload = {
        "institution": "wealthfront",
        "accounts": [
            {
                "name": "Roth IRA",
                "account_type": "ira",
                "external_id": "abc123",
            },
        ],
    }
    result = _post(port, "/ingest", payload)

    assert result["accounts_synced"] == 1
    assert result["balances_recorded"] == 0


def test_ingest_deduplicates_accounts(server):
    port, db, _ = server
    payload = {
        "institution": "ally",
        "accounts": [
            {
                "name": "Checking",
                "account_type": "checking",
                "external_id": "1234",
                "balance": 5000.00,
            },
        ],
    }
    # Send twice
    _post(port, "/ingest", payload)
    _post(port, "/ingest", payload)

    accounts = db.list_accounts()
    assert len(accounts) == 1


def test_ingest_missing_institution(server):
    port, _, _ = server
    payload = {"accounts": []}
    from urllib.error import HTTPError

    with pytest.raises(HTTPError):
        _post(port, "/ingest", payload)


def test_cookies_endpoint_stores_cookies(server):
    port, _, _ = server
    payload = {
        "institution": "wealthfront",
        "cookies": [
            {
                "name": "session_id",
                "value": "abc123",
                "domain": ".wealthfront.com",
                "path": "/",
                "httpOnly": True,
                "secure": True,
                "sameSite": "lax",
            },
            {
                "name": "csrf_token",
                "value": "xyz789",
                "domain": "www.wealthfront.com",
                "path": "/",
                "httpOnly": False,
                "secure": True,
                "sameSite": "strict",
            },
        ],
        "captured_at": "2025-01-01T00:00:00Z",
    }
    result = _post(port, "/cookies", payload)

    assert result["status"] == "ok"
    assert result["institution"] == "wealthfront"
    assert result["cookies_stored"] == 2

    # Verify cookies written to disk (persisted as {login_id}.json)
    from money.config import DATA_DIR

    path = DATA_DIR / "cookies" / "scott@wealthfront.json"
    assert path.exists()
    stored = json.loads(path.read_text())
    assert len(stored["cookies"]) == 2
    assert stored["cookies"][0]["name"] == "session_id"


# -- Close account --


def _make_synced_account(db, balance=157810.73, as_of=date(2026, 3, 31)):
    """An institution-synced account with one real balance row."""
    from money.models import Balance

    acct = db.get_or_create_account(
        name="401k",
        account_type=AccountType.FOUR_OH_ONE_K,
        institution="fidelity",
        external_id="x401k",
        profile="scott@fidelity",
    )
    db.insert_balance(
        Balance(account_id=acct.id, as_of=as_of, balance=balance, source="fidelity")
    )
    return acct


def test_close_account_sets_metadata_and_zero_balance(server):
    port, db, _ = server
    acct = _make_synced_account(db)
    assert db.net_worth(date(2026, 5, 31)) == pytest.approx(157810.73)

    result = _post(port, f"/api/accounts/{acct.id}/close", {"as_of": "2026-04-30"})
    assert result["closed"] is True
    assert result["closed_as_of"] == "2026-04-30"

    updated = db.get_account(acct.id)
    assert updated.metadata["closed"] is True
    assert updated.metadata["closed_as_of"] == "2026-04-30"

    bal = db.get_latest_balance(acct.id, date(2026, 5, 31))
    assert bal.balance == 0.0
    assert bal.as_of == date(2026, 4, 30)
    assert bal.source == "manual"

    # Net worth self-corrects from the close date; history before it is intact
    assert db.net_worth(date(2026, 5, 31)) == 0.0
    assert db.net_worth(date(2026, 4, 15)) == pytest.approx(157810.73)


def test_close_account_double_close_overwrites(server):
    port, db, _ = server
    acct = _make_synced_account(db)
    _post(port, f"/api/accounts/{acct.id}/close", {"as_of": "2026-04-30"})
    result = _post(port, f"/api/accounts/{acct.id}/close", {"as_of": "2026-05-15"})
    assert result["closed_as_of"] == "2026-05-15"
    assert db.get_account(acct.id).metadata["closed_as_of"] == "2026-05-15"


def test_close_account_unknown_id_404(server):
    port, _, _ = server
    with pytest.raises(HTTPError) as exc:
        _post(port, "/api/accounts/nope/close", {"as_of": "2026-04-30"})
    assert exc.value.code == 404


def test_close_account_bad_date_400(server):
    port, db, _ = server
    acct = _make_synced_account(db)
    for body in ({}, {"as_of": "not-a-date"}, {"as_of": 20260430}):
        with pytest.raises(HTTPError) as exc:
            _post(port, f"/api/accounts/{acct.id}/close", body)
        assert exc.value.code == 400


def test_closed_surfaced_in_accounts_listing(server):
    port, db, _ = server
    acct = _make_synced_account(db)

    accounts = _get(port, "/api/accounts")["accounts"]
    assert accounts[0]["closed"] is False
    assert accounts[0]["closed_as_of"] is None

    _post(port, f"/api/accounts/{acct.id}/close", {"as_of": "2026-04-30"})

    accounts = _get(port, "/api/accounts")["accounts"]
    assert accounts[0]["closed"] is True
    assert accounts[0]["closed_as_of"] == "2026-04-30"


def test_closed_metadata_survives_account_reupsert(server):
    port, db, _ = server
    acct = _make_synced_account(db)
    _post(port, f"/api/accounts/{acct.id}/close", {"as_of": "2026-04-30"})

    # A future sync re-upserting the account must not clobber metadata
    _post(port, "/ingest", {
        "institution": "fidelity",
        "accounts": [
            {
                "name": "401k",
                "account_type": "401k",
                "external_id": "x401k",
                "balance": 1234.56,
            },
        ],
    })

    updated = db.get_account(acct.id)
    assert updated.metadata["closed"] is True
    assert updated.metadata["closed_as_of"] == "2026-04-30"


def test_net_worth_history_zeroes_closed_performance_account(server):
    """An account WITH performance_history must drop to 0 at closed_as_of.

    Regression: history used to source such accounts only from
    performance_history (the $0 balances row from close was excluded by the
    NOT IN subquery), so the forward-fill carried the last real balance
    forever while the headline net worth showed 0.
    """
    from money.models import Balance

    port, db, _ = server
    acct = _make_synced_account(db)
    db.insert_performance(acct.id, date(2026, 3, 1), 150000.0, 100000.0, 50000.0)
    db.insert_performance(acct.id, date(2026, 3, 31), 157810.73, 100000.0, 57810.73)
    # An open account with a later balance creates series dates after the close
    other = db.get_or_create_account(
        name="Checking",
        account_type=AccountType.CHECKING,
        institution="ally",
        external_id="c1",
        profile="scott@ally",
    )
    db.insert_balance(
        Balance(account_id=other.id, as_of=date(2026, 6, 1), balance=100.0, source="ally")
    )

    _post(port, f"/api/accounts/{acct.id}/close", {"as_of": "2026-04-30"})

    series = {s["date"]: s for s in _get(port, "/api/net-worth/history")["series"]}
    # History before the close date is unchanged
    assert series["2026-03-01"]["net_worth"] == pytest.approx(150000.0)
    assert series["2026-03-31"]["net_worth"] == pytest.approx(157810.73)
    # On closed_as_of itself the account is 0 (matching the $0 balance row)
    assert series["2026-04-30"]["net_worth"] == 0.0
    # After the close only the open account remains
    assert series["2026-06-01"]["net_worth"] == pytest.approx(100.0)


def test_performance_series_zeroes_closed_account_at_close_date(server):
    port, db, _ = server
    acct = _make_synced_account(db)
    db.insert_performance(acct.id, date(2026, 3, 1), 150000.0, 100000.0, 50000.0)
    db.insert_performance(acct.id, date(2026, 3, 31), 157810.73, 100000.0, 57810.73)

    _post(port, f"/api/accounts/{acct.id}/close", {"as_of": "2026-04-30"})

    series = _get(port, "/api/performance")["series"]
    by_date = {s["date"]: s for s in series if s["account_id"] == acct.id}
    assert by_date["2026-03-31"]["balance"] == pytest.approx(157810.73)
    assert by_date["2026-04-30"]["balance"] == 0.0
    assert by_date["2026-04-30"]["invested"] == 0.0
    assert by_date["2026-04-30"]["earned"] == 0.0


def _insert_holding(db, account_id, value, asset_class, symbol):
    from money.models import Holding

    db.insert_holdings_batch([
        Holding(
            account_id=account_id,
            as_of=date(2026, 3, 31),
            name=symbol,
            shares=10.0,
            value=value,
            source="fidelity",
            symbol=symbol,
            asset_class=asset_class,
        )
    ])


def test_allocation_excludes_closed_accounts(server):
    port, db, _ = server
    acct = _make_synced_account(db)
    other = db.get_or_create_account(
        name="Brokerage",
        account_type=AccountType.BROKERAGE,
        institution="wealthfront",
        external_id="b1",
        profile="scott@wealthfront",
    )
    _insert_holding(db, acct.id, 157810.73, "US Stocks", "FXAIX")
    _insert_holding(db, other.id, 5000.0, "Bonds", "BND")

    _post(port, f"/api/accounts/{acct.id}/close", {"as_of": "2026-04-30"})

    allocation = _get(port, "/api/allocation")["allocation"]
    assert sum(a["value"] for a in allocation) == pytest.approx(5000.0)
    institutions = {i for a in allocation for i in a["by_institution"]}
    assert "fidelity" not in institutions


def test_holdings_excludes_closed_accounts(server):
    port, db, _ = server
    acct = _make_synced_account(db)
    other = db.get_or_create_account(
        name="Brokerage",
        account_type=AccountType.BROKERAGE,
        institution="wealthfront",
        external_id="b1",
        profile="scott@wealthfront",
    )
    _insert_holding(db, acct.id, 157810.73, "US Stocks", "FXAIX")
    _insert_holding(db, other.id, 5000.0, "Bonds", "BND")

    _post(port, f"/api/accounts/{acct.id}/close", {"as_of": "2026-04-30"})

    holdings = _get(port, "/api/holdings")["holdings"]
    assert [h["symbol"] for h in holdings] == ["BND"]


def test_sync_status_closed_accounts_never_stale(server, monkeypatch):
    port, db, _ = server
    from money import config as config_mod

    cfg = config_mod.AppConfig(
        institutions={"fidelity": config_mod.InstitutionConfig(label="Fidelity")},
        logins={
            "scott@fidelity": config_mod.LoginConfig(
                person="scott", institution="fidelity",
            ),
        },
        people={"scott": config_mod.PersonConfig(name="Scott")},
    )
    monkeypatch.setattr(config_mod, "load_config", lambda: cfg)

    acct = _make_synced_account(db)
    # Last successful sync 10 days ago -> stale while the account is open
    db.insert_sync("s1", "fidelity", "scott@fidelity", "2026-01-01T00:00:00")
    db.complete_sync(
        "s1", 1, 0, 1, 0, (datetime.now() - timedelta(days=10)).isoformat()
    )

    status = _get(port, "/api/sync-status")["statuses"][0]
    assert status["is_stale"] is True
    assert status["account_count"] == 1

    _post(port, f"/api/accounts/{acct.id}/close", {"as_of": "2026-04-30"})

    status = _get(port, "/api/sync-status")["statuses"][0]
    assert status["is_stale"] is False
    assert status["account_count"] == 0
