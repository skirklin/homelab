"""Tests for `money parse-test` — running parse_fn against a captured payload."""

import json
from pathlib import Path

import pytest
from click.testing import CliRunner

from money.cli import main


FIXTURES = Path(__file__).parent / "fixtures"


def _seed_capture(tmp_path: Path, institution: str, payload: dict) -> Path:
    captures = tmp_path / "unresolved_captures"
    captures.mkdir()
    path = captures / f"{institution}_20260514_000000.json"
    path.write_text(json.dumps(payload))
    return path


def test_parse_test_unknown_institution_errors(tmp_path, monkeypatch):
    _seed_capture(tmp_path, "chase", {"institution": "chase", "entries": []})
    monkeypatch.setattr("money.config.DATA_DIR", tmp_path)

    result = CliRunner().invoke(main, ["parse-test", "frobozz", "latest"])
    assert result.exit_code != 0
    assert "Unknown institution 'frobozz'" in result.output
    # The error should list known institutions so the operator can recover.
    assert "chase" in result.output


def test_parse_test_unsupported_anchor_file_errors(tmp_path, monkeypatch):
    """Institutions whose anchor_file isn't network_log.json should fail with
    a clear "not yet implemented" message, not a stack trace."""
    _seed_capture(tmp_path, "ally", {"institution": "ally", "entries": []})
    monkeypatch.setattr("money.config.DATA_DIR", tmp_path)

    result = CliRunner().invoke(main, ["parse-test", "ally", "latest"])
    assert result.exit_code != 0
    assert "accounts.json" in result.output
    assert "not yet implemented" in result.output


def test_parse_test_chase_minimal_capture_parses(tmp_path, monkeypatch):
    """A minimal chase capture should round-trip through parse_raw_chase
    without exploding, even if it produces zero rows."""
    # Stage a CHNetworkLog-shaped capture with an empty entries list.
    # parse_raw_chase will iterate and produce a zero-count summary.
    _seed_capture(tmp_path, "chase", {"institution": "chase", "entries": []})
    monkeypatch.setattr("money.config.DATA_DIR", tmp_path)

    result = CliRunner().invoke(main, ["parse-test", "chase", "latest"])
    assert result.exit_code == 0, result.output
    body = json.loads(result.stdout)
    assert body["institution"] == "chase"
    assert body["capture"].startswith("chase_")
    assert "parse_summary" in body


def test_parse_test_human_flag_renders_table(tmp_path, monkeypatch):
    _seed_capture(tmp_path, "chase", {"institution": "chase", "entries": []})
    monkeypatch.setattr("money.config.DATA_DIR", tmp_path)

    result = CliRunner().invoke(main, ["parse-test", "chase", "latest", "--human"])
    assert result.exit_code == 0
    assert "institution: chase" in result.output
    assert "parse_summary:" in result.output
    # Human output is not valid JSON.
    with pytest.raises(json.JSONDecodeError):
        json.loads(result.output)


def test_parse_test_no_db_writes_to_real_path(tmp_path, monkeypatch):
    """parse-test must use an in-memory DB, never touching the real money.db."""
    _seed_capture(tmp_path, "chase", {"institution": "chase", "entries": []})
    monkeypatch.setattr("money.config.DATA_DIR", tmp_path)

    real_db = tmp_path / "money.db"
    assert not real_db.exists()

    result = CliRunner().invoke(main, ["parse-test", "chase", "latest"])
    assert result.exit_code == 0
    # Nothing should have created money.db under DATA_DIR.
    assert not real_db.exists()
