"""Tests for `money capture list/inspect` and `money replay-capture`."""

import json
import os
import time
from pathlib import Path

import pytest
from click.testing import CliRunner

from money.cli import main


def _seed_capture(
    directory: Path,
    filename: str,
    payload: dict[str, object],
    mtime: float | None = None,
) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / filename
    path.write_text(json.dumps(payload))
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """Patch money.config.DATA_DIR so the CLI looks at a temp tree."""
    monkeypatch.setattr("money.config.DATA_DIR", tmp_path)
    return tmp_path


class TestCaptureList:
    def test_orders_by_mtime_and_limits(self, data_dir):
        net_logs = data_dir / "network_logs"
        now = time.time()
        _seed_capture(net_logs, "ally_20260514_080000.json", {"entries": []}, mtime=now - 200)
        _seed_capture(net_logs, "chase_20260514_090000.json", {"entries": []}, mtime=now - 100)
        _seed_capture(net_logs, "fidelity_20260514_100000.json", {"entries": []}, mtime=now)

        runner = CliRunner()
        result = runner.invoke(main, ["capture", "list"])
        assert result.exit_code == 0, result.output
        lines = [l for l in result.output.splitlines() if l.strip()]
        # newest first
        assert lines[0].endswith("fidelity_20260514_100000.json")
        assert lines[1].endswith("chase_20260514_090000.json")
        assert lines[2].endswith("ally_20260514_080000.json")

        result_limit = runner.invoke(main, ["capture", "list", "--limit", "1"])
        assert result_limit.exit_code == 0
        limit_lines = [l for l in result_limit.output.splitlines() if l.strip()]
        assert len(limit_lines) == 1
        assert limit_lines[0].endswith("fidelity_20260514_100000.json")

        result_filter = runner.invoke(main, ["capture", "list", "--institution", "ally"])
        assert result_filter.exit_code == 0
        filt_lines = [l for l in result_filter.output.splitlines() if l.strip()]
        assert len(filt_lines) == 1
        assert filt_lines[0].endswith("ally_20260514_080000.json")

    def test_unresolved_flag_uses_quarantine_dir(self, data_dir):
        unresolved = data_dir / "unresolved_captures"
        netlogs = data_dir / "network_logs"
        _seed_capture(unresolved, "ally_20260514_080000.json", {"entries": []})
        _seed_capture(netlogs, "chase_20260514_090000.json", {"entries": []})

        runner = CliRunner()
        result = runner.invoke(main, ["capture", "list", "--unresolved"])
        assert result.exit_code == 0
        assert "ally_20260514_080000.json" in result.output
        assert "chase_20260514_090000.json" not in result.output


class TestCaptureInspect:
    def test_summary_includes_urls_and_cookie_names(self, data_dir):
        netlogs = data_dir / "network_logs"
        payload = {
            "institution": "ally",
            "entries": [
                {"url": "https://secure.ally.com/acs/v3/customers/self"},
                {"url": "https://secure.ally.com/acs/v3/accounts"},
            ],
            "cookies": [
                {"name": "session", "value": "abc"},
                {"name": "ally_csrf", "value": "xyz"},
            ],
        }
        _seed_capture(netlogs, "ally_20260514_080000.json", payload)

        runner = CliRunner()
        result = runner.invoke(main, ["capture", "inspect", "ally"])
        assert result.exit_code == 0, result.output
        assert "customers/self" in result.output
        assert "accounts" in result.output
        assert "session" in result.output
        assert "ally_csrf" in result.output

    def test_bogus_id_exits_nonzero(self, data_dir):
        netlogs = data_dir / "network_logs"
        _seed_capture(netlogs, "ally_20260514_080000.json", {"entries": []})

        runner = CliRunner()
        result = runner.invoke(main, ["capture", "inspect", "bogus"])
        assert result.exit_code != 0
        assert "No capture matched" in result.output or "No capture matched" in str(
            result.exception or ""
        )

    def test_field_path(self, data_dir):
        netlogs = data_dir / "network_logs"
        payload = {"entries": [{"url": "https://example.com/api/x"}]}
        _seed_capture(netlogs, "ally_20260514_080000.json", payload)

        runner = CliRunner()
        result = runner.invoke(
            main, ["capture", "inspect", "ally", "--field", "entries.0.url"]
        )
        assert result.exit_code == 0, result.output
        assert result.output.strip() == '"https://example.com/api/x"'

    def test_missing_field_exits_nonzero(self, data_dir):
        netlogs = data_dir / "network_logs"
        _seed_capture(netlogs, "ally_20260514_080000.json", {"entries": []})

        runner = CliRunner()
        result = runner.invoke(
            main, ["capture", "inspect", "ally", "--field", "does.not.exist"]
        )
        assert result.exit_code != 0

    def test_raw_dumps_file(self, data_dir):
        netlogs = data_dir / "network_logs"
        payload = {"entries": [{"url": "https://example.com/x"}]}
        path = _seed_capture(netlogs, "ally_20260514_080000.json", payload)

        runner = CliRunner()
        result = runner.invoke(main, ["capture", "inspect", "ally", "--raw"])
        assert result.exit_code == 0
        # The first line of output should be the file contents verbatim.
        assert result.output.rstrip("\n") == path.read_text()
