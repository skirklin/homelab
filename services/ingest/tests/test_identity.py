"""Tests for institution identity extraction against real capture data."""

import json
from pathlib import Path

import pytest

# Real captures from the old money project
CAPTURES_DIR = Path("/home/skirklin/projects/money/.data")
NETWORK_LOGS = CAPTURES_DIR / "network_logs"
COOKIES_DIR = CAPTURES_DIR / "cookies"


def _load_entries(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    return data.get("entries", [])


def _load_cookies(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    return data.get("cookies", [])


@pytest.mark.skipif(not NETWORK_LOGS.exists(), reason="No real captures available")
class TestIdentityExtraction:
    def test_ally_extracts_username(self):
        from money.ingest.ally_api import _extract_identity

        entries = _load_entries(NETWORK_LOGS / "ally_20260408_092144.json")
        result = _extract_identity([], entries)
        assert result == "kirk4000"

    def test_wealthfront_extracts_email(self):
        from money.ingest.wealthfront import _extract_identity

        entries = _load_entries(NETWORK_LOGS / "wealthfront_20260314_092754.json")
        result = _extract_identity([], entries)
        assert result == "scott.kirklin@gmail.com"

    def test_capital_one_extracts_username_from_cookie(self):
        from money.ingest.capital_one import _extract_identity

        cookies = _load_cookies(COOKIES_DIR / "scott@capital_one.json")
        result = _extract_identity(cookies, [])
        assert result == "kirk"

    def test_wealthfront_returns_none_without_user_entry(self):
        from money.ingest.wealthfront import _extract_identity

        result = _extract_identity([], [{"url": "https://wealthfront.com/api/overview", "responseBody": {}}])
        assert result is None

    def test_capital_one_returns_none_without_cookie(self):
        from money.ingest.capital_one import _extract_identity

        result = _extract_identity([{"name": "session", "value": "abc"}], [])
        assert result is None
