"""Tests for the /capture endpoint and login resolution logic."""

import json
import tempfile
from http.server import HTTPServer
from threading import Thread
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from money.config import AppConfig, InstitutionConfig, LoginConfig, PersonConfig
from money.db import Database
from money.server import IngestHandler
from money.storage import LocalStore


def _make_config(logins: dict[str, LoginConfig]) -> AppConfig:
    institutions = {}
    people = {}
    for lid, lc in logins.items():
        institutions[lc.institution] = InstitutionConfig(label=lc.institution)
        people[lc.person] = PersonConfig(name=lc.person)
    return AppConfig(institutions=institutions, logins=logins, people=people)


SCOTT_ONLY = _make_config({
    "scott@wealthfront": LoginConfig(person="scott", institution="wealthfront", username="scott@gmail.com"),
})

MULTI_USER = _make_config({
    "scott@betterment": LoginConfig(person="scott", institution="betterment", username="Scott"),
    "angela@betterment": LoginConfig(person="angela", institution="betterment", username="Angela"),
})

MULTI_NO_USERNAMES = _make_config({
    "scott@chase": LoginConfig(person="scott", institution="chase"),
    "angela@chase": LoginConfig(person="angela", institution="chase"),
})

SINGLE_NO_USERNAME = _make_config({
    "scott@fidelity": LoginConfig(person="scott", institution="fidelity"),
})


@pytest.fixture
def server():
    db = Database(":memory:", check_same_thread=False)
    db.initialize()
    with tempfile.TemporaryDirectory() as tmpdir:
        store = LocalStore(tmpdir)
        IngestHandler.db = db
        IngestHandler.store = store
        httpd = HTTPServer(("127.0.0.1", 0), IngestHandler)
        port = httpd.server_address[1]
        thread = Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        yield port, db, tmpdir
        httpd.shutdown()
    db.close()


def _post(port, path, data):
    body = json.dumps(data).encode()
    req = Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return urlopen(req)


def _post_json(port, path, data):
    resp = _post(port, path, data)
    return json.loads(resp.read())


def _post_expect_error(port, path, data):
    with pytest.raises(HTTPError) as exc_info:
        _post(port, path, data)
    return json.loads(exc_info.value.read())


class TestCaptureEndpoint:
    def test_capture_with_identity_match(self, server):
        port, db, _ = server
        with patch("money.config.load_config", return_value=MULTI_USER):
            result = _post_json(port, "/capture", {
                "institution": "betterment",
                "cookies": [{"name": "session", "value": "abc"}],
                "entries": [],
                "user_identity": "Scott",
            })
        assert result["status"] == "ok"
        assert result["login_id"] == "scott@betterment"

    def test_capture_identity_match_case_insensitive(self, server):
        port, _, _ = server
        with patch("money.config.load_config", return_value=MULTI_USER):
            result = _post_json(port, "/capture", {
                "institution": "betterment",
                "cookies": [],
                "entries": [],
                "user_identity": "scott",
            })
        assert result["login_id"] == "scott@betterment"

    def test_capture_single_login_no_identity_succeeds(self, server):
        port, _, _ = server
        with patch("money.config.load_config", return_value=SINGLE_NO_USERNAME):
            result = _post_json(port, "/capture", {
                "institution": "fidelity",
                "cookies": [],
                "entries": [],
            })
        assert result["status"] == "ok"
        assert result["login_id"] == "scott@fidelity"

    def test_capture_multi_login_no_identity_fails(self, server):
        port, _, _ = server
        with patch("money.config.load_config", return_value=MULTI_NO_USERNAMES):
            result = _post_expect_error(port, "/capture", {
                "institution": "chase",
                "cookies": [],
                "entries": [],
            })
        assert "Could not determine user" in result["error"]

    def test_capture_identity_no_username_match_fails(self, server):
        port, _, _ = server
        with patch("money.config.load_config", return_value=MULTI_USER):
            result = _post_expect_error(port, "/capture", {
                "institution": "betterment",
                "cookies": [],
                "entries": [],
                "user_identity": "Unknown Person",
            })
        assert "Could not determine user" in result["error"]

    def test_capture_no_logins_configured_fails(self, server):
        port, _, _ = server
        empty = AppConfig(institutions={}, logins={}, people={})
        with patch("money.config.load_config", return_value=empty):
            result = _post_expect_error(port, "/capture", {
                "institution": "chase",
                "cookies": [],
                "entries": [],
            })
        assert "Could not determine user" in result["error"]

    def test_capture_persists_cookies_and_entries(self, server):
        port, _, tmpdir = server
        with patch("money.config.load_config", return_value=SCOTT_ONLY):
            result = _post_json(port, "/capture", {
                "institution": "wealthfront",
                "cookies": [{"name": "token", "value": "abc"}],
                "entries": [{"url": "https://wealthfront.com/api/test", "responseBody": {}}],
                "user_identity": "scott@gmail.com",
            })
        assert result["cookies_stored"] == 1
        assert result["entries_stored"] == 1

        from money.config import DATA_DIR
        assert (DATA_DIR / "cookies" / "scott@wealthfront.json").exists()

    def test_capture_missing_institution_returns_400(self, server):
        port, _, _ = server
        result = _post_expect_error(port, "/capture", {
            "cookies": [], "entries": [],
        })
        assert "institution" in result["error"]


class TestExtractIdentityIntegration:
    """Test that server-side extract_identity is called during /capture."""

    def test_ally_identity_from_entries(self, server):
        port, _, _ = server
        config = _make_config({
            "scott@ally": LoginConfig(person="scott", institution="ally", username="kirk4000"),
            "angela@ally": LoginConfig(person="angela", institution="ally", username="angela123"),
        })
        entries = [
            {
                "url": "https://secure.ally.com/acs/customers/authenticate/api/v2/auth/login?aid=ciam_web",
                "requestBody": '{"headers":[{"type":"uid","uid":"kirk4000"}],"data":{}}',
            },
        ]
        with patch("money.config.load_config", return_value=config):
            result = _post_json(port, "/capture", {
                "institution": "ally",
                "cookies": [],
                "entries": entries,
            })
        assert result["login_id"] == "scott@ally"

    def test_ally_identity_from_customers_self(self, server):
        port, _, _ = server
        config = _make_config({
            "scott@ally": LoginConfig(person="scott", institution="ally", username="scott@example.com"),
        })
        entries = [{
            "url": "https://secure.ally.com/acs/v3/customers/self",
            "responseBody": {"data": {"emails": [
                {"type": "PRIMARY", "value": "scott@example.com"},
                {"type": "SECONDARY", "value": "other@example.com"},
            ]}},
        }]
        with patch("money.config.load_config", return_value=config):
            result = _post_json(port, "/capture", {
                "institution": "ally", "cookies": [], "entries": entries,
            })
        assert result["login_id"] == "scott@ally"

    def test_capital_one_identity_from_cookies(self, server):
        port, _, _ = server
        config = _make_config({
            "scott@capital_one": LoginConfig(person="scott", institution="capital_one", username="kirk"),
        })
        cookies = [
            {"name": "SIC_RM_VAL", "value": "kirk%7CsomeHash"},
            {"name": "session", "value": "abc"},
        ]
        with patch("money.config.load_config", return_value=config):
            result = _post_json(port, "/capture", {
                "institution": "capital_one",
                "cookies": cookies,
                "entries": [],
                "user_identity": "kirk",
            })
        assert result["login_id"] == "scott@capital_one"

    def test_wealthfront_identity_from_entries(self, server):
        port, _, _ = server
        config = _make_config({
            "scott@wealthfront": LoginConfig(person="scott", institution="wealthfront", username="scott@gmail.com"),
            "angela@wealthfront": LoginConfig(person="angela", institution="wealthfront", username="angela@gmail.com"),
        })
        entries = [
            {
                "url": "https://www.wealthfront.com/api/users/current-user",
                "responseBody": {"email": "scott@gmail.com", "id": 12345},
            },
        ]
        with patch("money.config.load_config", return_value=config):
            result = _post_json(port, "/capture", {
                "institution": "wealthfront",
                "cookies": [],
                "entries": entries,
            })
        assert result["login_id"] == "scott@wealthfront"
