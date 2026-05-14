"""Tests for `money config get/set/edit`."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner

from money.cli import main


SEED_CONFIG: dict[str, object] = {
    "people": {
        "scott": {"name": "Scott"},
    },
    "institutions": {
        "ally": {"label": "Ally Bank", "url": "https://ally.com"},
        "chase": {"label": "Chase", "url": "https://chase.com"},
    },
    "logins": {
        "scott@ally": {
            "person": "scott",
            "institution": "ally",
            "username": "queenofblades",
        },
        "scott@chase": {
            "person": "scott",
            "institution": "chase",
            "username": "scott123",
        },
    },
}


@pytest.fixture
def config_path(tmp_path, monkeypatch) -> Path:
    """Patch DATA_DIR (and CONFIG_DIR) so config resolution lands in tmp_path,
    and seed it with SEED_CONFIG."""
    monkeypatch.setattr("money.config.DATA_DIR", tmp_path)
    monkeypatch.setattr("money.config.CONFIG_DIR", tmp_path)
    monkeypatch.setattr("money.config.CONFIG_FILE", tmp_path / "config.json")
    path = tmp_path / "config.json"
    path.write_text(json.dumps(SEED_CONFIG, indent=2, sort_keys=True) + "\n")
    return path


def _invoke(args: list[str], input_str: str | None = None) -> object:
    runner = CliRunner()
    return runner.invoke(main, args, input=input_str)


class TestGet:
    def test_get_dotted_returns_scalar(self, config_path: Path) -> None:
        result = _invoke(["config", "get", 'logins["scott@ally"].username'])
        assert result.exit_code == 0, result.output
        assert json.loads(result.output) == "queenofblades"

    def test_get_missing_key_exits_nonzero(self, config_path: Path) -> None:
        result = _invoke(["config", "get", 'logins["nonexistent"].username'])
        assert result.exit_code != 0
        assert "Key not found" in result.output or "nonexistent" in result.output

    def test_get_json_default_vs_human_flag(self, config_path: Path) -> None:
        json_result = _invoke(["config", "get", 'logins["scott@ally"].username'])
        assert json_result.exit_code == 0
        json.loads(json_result.output)  # parseable

        human_result = _invoke(
            ["config", "get", 'logins["scott@ally"].username', "--human"]
        )
        assert human_result.exit_code == 0
        assert human_result.output.strip() == "queenofblades"

    def test_get_no_path_dumps_whole_config(self, config_path: Path) -> None:
        result = _invoke(["config", "get"])
        assert result.exit_code == 0, result.output
        payload = json.loads(result.output)
        assert payload["logins"]["scott@ally"]["username"] == "queenofblades"


class TestSet:
    def test_set_dry_run_emits_diff_no_write(self, config_path: Path) -> None:
        before_text = config_path.read_text()
        before_mtime = config_path.stat().st_mtime

        result = _invoke(
            [
                "config",
                "set",
                'logins["scott@ally"].username',
                "newname",
                "--dry-run",
            ]
        )
        assert result.exit_code == 0, result.output
        assert "queenofblades" in result.output
        assert "newname" in result.output
        # File should be untouched.
        assert config_path.read_text() == before_text
        assert config_path.stat().st_mtime == before_mtime
        # Summary line must indicate dry_run.
        summary_line = result.output.strip().splitlines()[-1]
        summary = json.loads(summary_line)
        assert summary["dry_run"] is True
        assert summary["backup"] is None

    def test_set_writes_atomically_and_rotates_backup(
        self, config_path: Path, monkeypatch
    ) -> None:
        # Pre-create 5 fake backup files to verify rotation.
        for i in range(5):
            ts = f"2026010{i}_120000"
            (config_path.parent / f"config.json.bak.{ts}").write_text("stale")

        result = _invoke(
            ["config", "set", 'logins["scott@ally"].username', "newname"]
        )
        assert result.exit_code == 0, result.output
        summary = json.loads(result.output.strip().splitlines()[-1])
        assert summary["backup"] is not None
        assert Path(summary["backup"]).exists()

        # After a single new write + rotation: still 5 backups (one rotated out).
        backups = sorted(p.name for p in config_path.parent.glob("config.json.bak.*"))
        assert len(backups) == 5, backups

        # File content matches expectation.
        new_cfg = json.loads(config_path.read_text())
        assert new_cfg["logins"]["scott@ally"]["username"] == "newname"

    def test_set_fsync_failure_leaves_target_untouched(
        self, config_path: Path, monkeypatch
    ) -> None:
        before_text = config_path.read_text()
        from money import config_io as cio

        # Force atomic_write to blow up mid-flight.
        real_fsync = os.fsync

        def broken_fsync(fd: int) -> None:
            raise OSError("simulated disk failure")

        monkeypatch.setattr(cio.os, "fsync", broken_fsync)

        result = _invoke(
            ["config", "set", 'logins["scott@ally"].username', "newname"]
        )
        # Restore so cleanup elsewhere doesn't error.
        monkeypatch.setattr(cio.os, "fsync", real_fsync)

        assert result.exit_code != 0
        # Target file MUST still hold the original content.
        assert config_path.read_text() == before_text
        # No stray tmp files left behind.
        leftovers = [
            p for p in config_path.parent.iterdir() if p.name.startswith(".config.json.tmp")
        ]
        assert leftovers == []

    def test_set_rejects_unknown_login_person_fk(self, config_path: Path) -> None:
        result = _invoke(
            [
                "config",
                "set",
                'logins["scott@ally"].person',
                "phantomuser",
            ]
        )
        assert result.exit_code != 0
        assert "phantomuser" in result.output or "unknown person" in result.output

    def test_set_bracket_path_with_at_sign(self, config_path: Path) -> None:
        # The "@" character is the canonical reason to require bracket syntax.
        result = _invoke(
            ["config", "set", "logins[scott@ally].username", "newname"]
        )
        assert result.exit_code == 0, result.output
        new_cfg = json.loads(config_path.read_text())
        assert new_cfg["logins"]["scott@ally"]["username"] == "newname"

    def test_set_bare_dotted_path_with_at_is_rejected(self, config_path: Path) -> None:
        result = _invoke(
            ["config", "set", "logins.scott@ally.username", "newname"]
        )
        assert result.exit_code != 0
        assert "bracket" in result.output.lower()


class TestEdit:
    def _editor_writes(self, payload: dict[str, object]) -> str:
        """Build an `editor` command-line shim that overwrites the tempfile with `payload`."""
        text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
        # Use python -c to write the payload — works portably under subprocess.run.
        return text

    def test_edit_uses_VISUAL_then_EDITOR_then_vi(
        self, config_path: Path, monkeypatch
    ) -> None:
        seen: list[str] = []

        def fake_run(argv, *args, **kwargs):
            seen.append(argv[0])
            # Don't touch the tempfile; this preserves the original contents
            # which means the diff is empty and the command exits without
            # prompting.
            return subprocess.CompletedProcess(argv, 0, "", "")

        monkeypatch.setattr(subprocess, "run", fake_run)

        monkeypatch.setenv("VISUAL", "my-visual-editor")
        monkeypatch.setenv("EDITOR", "my-text-editor")
        result = _invoke(["config", "edit"])
        assert result.exit_code == 0, result.output
        assert seen[-1] == "my-visual-editor"

        monkeypatch.delenv("VISUAL", raising=False)
        result = _invoke(["config", "edit"])
        assert result.exit_code == 0, result.output
        assert seen[-1] == "my-text-editor"

        monkeypatch.delenv("EDITOR", raising=False)
        result = _invoke(["config", "edit"])
        assert result.exit_code == 0, result.output
        assert seen[-1] == "vi"

    def test_edit_aborts_on_no_change(
        self, config_path: Path, monkeypatch
    ) -> None:
        before_backups = list(config_path.parent.glob("config.json.bak.*"))

        def noop_editor(argv, *args, **kwargs):
            # Don't touch the file; the diff will be empty.
            return subprocess.CompletedProcess(argv, 0, "", "")

        monkeypatch.setattr(subprocess, "run", noop_editor)
        monkeypatch.setenv("EDITOR", "noop")

        result = _invoke(["config", "edit"])
        assert result.exit_code == 0, result.output
        assert "no change" in result.output.lower()

        after_backups = list(config_path.parent.glob("config.json.bak.*"))
        assert len(after_backups) == len(before_backups)

    def test_edit_applies_change_with_yes(
        self, config_path: Path, monkeypatch
    ) -> None:
        new_username = "edited-via-editor"
        new_payload = json.loads(config_path.read_text())
        new_payload["logins"]["scott@ally"]["username"] = new_username

        def writing_editor(argv, *args, **kwargs):
            # argv: ["my-editor", tmp_path]
            Path(argv[1]).write_text(json.dumps(new_payload, indent=2, sort_keys=True) + "\n")
            return subprocess.CompletedProcess(argv, 0, "", "")

        monkeypatch.setattr(subprocess, "run", writing_editor)
        monkeypatch.setenv("EDITOR", "my-editor")

        result = _invoke(["config", "edit", "--yes"])
        assert result.exit_code == 0, result.output
        on_disk = json.loads(config_path.read_text())
        assert on_disk["logins"]["scott@ally"]["username"] == new_username
