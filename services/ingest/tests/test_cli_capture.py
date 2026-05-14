"""Tests for `money capture list/inspect` and `money replay-capture`."""

import json
import os
import tempfile
import time
from http.server import HTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

import pytest
from click.testing import CliRunner

from money.cli import main
from money.config import AppConfig, InstitutionConfig, LoginConfig, PersonConfig
from money.db import Database
from money.server import IngestHandler
from money.storage import LocalStore


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


def _make_config(logins: dict[str, LoginConfig]) -> AppConfig:
    institutions = {}
    people = {}
    for _lid, lc in logins.items():
        institutions[lc.institution] = InstitutionConfig(label=lc.institution)
        people[lc.person] = PersonConfig(name=lc.person)
    return AppConfig(institutions=institutions, logins=logins, people=people)


SINGLE_WEALTHFRONT = _make_config({
    "scott@wealthfront": LoginConfig(
        person="scott", institution="wealthfront", username="scott@gmail.com",
    ),
})


@pytest.fixture
def replay_server():
    """Spin up an IngestHandler on a random port. Yields (port, db, tmpdir)."""
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


class TestReplayCapture:
    def test_replay_unresolved_capture(self, data_dir, replay_server, monkeypatch):
        port, _, _ = replay_server
        # Quarantine the data dir for the server side too so persisted files
        # land in tmp.
        monkeypatch.setattr("money.server.DATA_DIR", data_dir, raising=False)
        unresolved = data_dir / "unresolved_captures"
        payload = {
            "institution": "wealthfront",
            "cookies": [{"name": "session", "value": "abc"}],
            "entries": [],
            "user_identity": "scott@gmail.com",
        }
        _seed_capture(unresolved, "wealthfront_20260514_080000.json", payload)

        runner = CliRunner()
        with patch("money.config.load_config", return_value=SINGLE_WEALTHFRONT):
            result = runner.invoke(
                main,
                ["replay-capture", "wealthfront", "--url", f"http://127.0.0.1:{port}/capture"],
            )
        assert result.exit_code == 0, result.output
        assert '"login_id": "scott@wealthfront"' in result.output \
            or '"login_id":"scott@wealthfront"' in result.output

    def test_as_login_overrides_user_identity(self, data_dir, replay_server, monkeypatch):
        port, _, _ = replay_server
        monkeypatch.setattr("money.server.DATA_DIR", data_dir, raising=False)
        unresolved = data_dir / "unresolved_captures"
        # Stored capture has a wrong identity; --as-login should override.
        payload = {
            "institution": "wealthfront",
            "cookies": [{"name": "session", "value": "abc"}],
            "entries": [],
            "user_identity": "wrong-identity@example.com",
        }
        _seed_capture(unresolved, "wealthfront_20260514_080000.json", payload)

        runner = CliRunner()
        with patch("money.config.load_config", return_value=SINGLE_WEALTHFRONT):
            result = runner.invoke(
                main,
                [
                    "replay-capture",
                    "wealthfront",
                    "--as-login",
                    "scott@gmail.com",
                    "--url",
                    f"http://127.0.0.1:{port}/capture",
                ],
            )
        assert result.exit_code == 0, result.output
        assert "scott@wealthfront" in result.output

    def test_latest_keyword(self, data_dir, replay_server, monkeypatch):
        port, _, _ = replay_server
        monkeypatch.setattr("money.server.DATA_DIR", data_dir, raising=False)
        unresolved = data_dir / "unresolved_captures"
        now = time.time()
        old_payload = {
            "institution": "wealthfront",
            "cookies": [{"name": "session", "value": "old"}],
            "entries": [],
            "user_identity": "scott@gmail.com",
        }
        new_payload = {
            "institution": "wealthfront",
            "cookies": [{"name": "session", "value": "new"}],
            "entries": [],
            "user_identity": "scott@gmail.com",
        }
        _seed_capture(unresolved, "wealthfront_20260514_070000.json", old_payload, mtime=now - 100)
        _seed_capture(unresolved, "wealthfront_20260514_080000.json", new_payload, mtime=now)

        runner = CliRunner()
        with patch("money.config.load_config", return_value=SINGLE_WEALTHFRONT):
            result = runner.invoke(
                main, ["replay-capture", "latest", "--url", f"http://127.0.0.1:{port}/capture"],
            )
        assert result.exit_code == 0, result.output
        assert "wealthfront_20260514_080000.json" in result.output

    def test_bogus_ref_exits_nonzero(self, data_dir):
        unresolved = data_dir / "unresolved_captures"
        _seed_capture(unresolved, "wealthfront_20260514_080000.json", {"institution": "wealthfront"})

        runner = CliRunner()
        result = runner.invoke(main, ["replay-capture", "totally-not-real"])
        assert result.exit_code != 0
