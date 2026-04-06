"""Tests for the extension data receiver server."""

import json
import tempfile
from datetime import date
from http.server import HTTPServer
from threading import Thread
from urllib.request import Request, urlopen

import pytest

from money.db import Database
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
