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
                # At least one of (cookies, entries, user_identity) must be
                # non-empty or the server treats it as a no-op. Here we
                # exercise the single-login-unambiguous fallback path.
                "cookies": [{"name": "session", "value": "abc"}],
                "entries": [],
            })
        assert result["status"] == "ok"
        assert result["login_id"] == "scott@fidelity"

    def test_capture_single_login_no_identity_logs_fallback(self, server):
        """The single-login fallback must emit a loud IDENTITY_FALLBACK error
        in the log so missing extract_identity implementations are visible
        in kubectl logs."""
        port, _, _ = server
        # caplog runs on the test thread, but the HTTPServer dispatches the
        # handler on a worker thread, so caplog may miss the record. Use a
        # mock on the server's logger instead and inspect its calls.
        with patch("money.server.log.error") as mock_error:
            with patch("money.config.load_config", return_value=SINGLE_NO_USERNAME):
                result = _post_json(port, "/capture", {
                    "institution": "fidelity",
                    "cookies": [{"name": "session", "value": "abc"}],
                    "entries": [],
                })
        assert result["login_id"] == "scott@fidelity"
        assert mock_error.call_count >= 1
        # First positional arg is the format string; following args are the
        # interpolation values. The format string carries the IDENTITY_FALLBACK
        # tag.
        fmt_strings = [
            call.args[0] for call in mock_error.call_args_list if call.args
        ]
        assert any("IDENTITY_FALLBACK" in s for s in fmt_strings), fmt_strings

    def test_capture_multi_login_no_identity_fails(self, server):
        port, _, _ = server
        with patch("money.config.load_config", return_value=MULTI_NO_USERNAMES):
            result = _post_expect_error(port, "/capture", {
                "institution": "chase",
                "cookies": [],
                "entries": [],
                # Non-empty identity defeats the empty-capture short-circuit
                # but doesn't match any configured login -> quarantine.
                "user_identity": "Unknown Person",
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
                # Defeat the empty-capture short-circuit so we actually
                # exercise the no-logins-configured failure path.
                "user_identity": "Someone",
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

    def test_capture_empty_entries_handled(self, server, monkeypatch, tmp_path):
        """Extension's webNavigation race fires post-login callbacks with no
        cookies and no entries; we should treat those as benign no-ops, not
        quarantine them."""
        port, _, tmpdir = server
        # Isolate DATA_DIR so the quarantine check is meaningful.
        monkeypatch.setattr("money.config.DATA_DIR", tmp_path)
        monkeypatch.setattr("money.server.DATA_DIR", tmp_path, raising=False)
        with patch("money.config.load_config", return_value=MULTI_USER):
            result = _post_json(port, "/capture", {
                "institution": "betterment", "cookies": [], "entries": [],
            })
        assert result["status"] == "noop"
        quarantine = tmp_path / "unresolved_captures"
        assert not quarantine.exists() or not any(quarantine.iterdir())

    def test_capture_missing_institution_returns_400(self, server):
        port, _, _ = server
        result = _post_expect_error(port, "/capture", {
            "cookies": [], "entries": [],
        })
        assert "institution" in result["error"]


class TestExtractIdentityIntegration:
    """Test that server-side extract_identity is called during /capture."""

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
