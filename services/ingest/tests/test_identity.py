"""Tests for institution identity extraction against anonymized capture fixtures.

Fixtures live in `tests/fixtures/` and were produced from real captures via
`scripts/scrub_fixture.py`.  Real identifiers were replaced with the canonical
scrubbed values:

    * `test@example.com` for emails
    * `testuser` for per-institution login usernames
    * `999999999999999` for long numeric customer IDs
    * `Test`/`User` for first/last names
"""

import json
from pathlib import Path

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _load_entries(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    return data.get("entries", [])


def _load_cookies(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    return data.get("cookies", [])


class TestIdentityExtraction:
    def test_ally_extracts_email_from_customers_self(self):
        from money.ingest.ally_api import _extract_identity

        entries = _load_entries(FIXTURES_DIR / "ally_network_log.json")
        result = _extract_identity([], entries)
        assert result == "test@example.com"

    def test_wealthfront_extracts_email(self):
        from money.ingest.wealthfront import _extract_identity

        entries = _load_entries(FIXTURES_DIR / "wealthfront_network_log.json")
        result = _extract_identity([], entries)
        assert result == "test@example.com"

    def test_capital_one_extracts_username_from_cookie(self):
        from money.ingest.capital_one import _extract_identity

        cookies = _load_cookies(FIXTURES_DIR / "capital_one_cookies.json")
        result = _extract_identity(cookies, [])
        assert result == "testuser"

    def test_wealthfront_returns_none_without_user_entry(self):
        from money.ingest.wealthfront import _extract_identity

        result = _extract_identity([], [{"url": "https://wealthfront.com/api/overview", "responseBody": {}}])
        assert result is None

    def test_capital_one_returns_none_without_cookie(self):
        from money.ingest.capital_one import _extract_identity

        result = _extract_identity([{"name": "session", "value": "abc"}], [])
        assert result is None


def test_ally_extracts_primary_email_from_customers_self():
    """Unit test: Ally _extract_identity should return the PRIMARY email
    from a /customers/self response body."""
    from money.ingest.ally_api import _extract_identity

    entries = [{
        "url": "https://secure.ally.com/acs/v3/customers/self",
        "responseBody": {"data": {"emails": [
            {"type": "PRIMARY", "value": "scott@example.com"},
            {"type": "SECONDARY", "value": "other@example.com"},
        ]}},
    }]
    result = _extract_identity([], entries)
    assert result == "scott@example.com"
