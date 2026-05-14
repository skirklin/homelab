"""Tests for `money registry probe`."""

import json
import sys

from click.testing import CliRunner

from money.cli import main


KNOWN_INSTITUTIONS = {
    "ally",
    "betterment",
    "capital_one",
    "chase",
    "fidelity",
    "morgan_stanley",
    "wealthfront",
}


def _run_probe(args: list[str] | None = None) -> "tuple[int, str]":
    runner = CliRunner()
    result = runner.invoke(main, ["registry", "probe", *(args or [])])
    return result.exit_code, result.output


def test_probe_lists_all_known_institutions() -> None:
    exit_code, output = _run_probe()
    assert exit_code == 0, output
    payload = json.loads(output)
    names = {r["name"] for r in payload["registered"]}
    assert KNOWN_INSTITUTIONS.issubset(names), names


def test_probe_marks_extract_identity_capability() -> None:
    exit_code, output = _run_probe()
    assert exit_code == 0, output
    payload = json.loads(output)
    by_name = {r["name"]: r for r in payload["registered"]}
    # ally has extract_identity, chase does not.
    assert by_name["ally"]["has_extract_identity"] is True
    assert by_name["chase"]["has_extract_identity"] is False


def test_probe_surfaces_failed_import(tmp_path, monkeypatch) -> None:
    """A synthetic broken institution module should appear under `failed`."""
    import money.ingest as pkg

    # Drop a module that raises on import into the actual money.ingest package
    # path so pkgutil.iter_modules picks it up.
    pkg_dir = next(iter(pkg.__path__))
    broken_path = f"{pkg_dir}/_broken_for_tests.py"
    with open(broken_path, "w") as fh:
        fh.write("raise ImportError('synthetic broken module for tests')\n")

    # Make sure any cached import doesn't shortcut.
    sys.modules.pop("money.ingest._broken_for_tests", None)

    try:
        exit_code, output = _run_probe()
        assert exit_code == 0, output
        payload = json.loads(output)
        failed = payload["failed"]
        assert any(
            f["module"].endswith("_broken_for_tests")
            and "synthetic broken module" in f["error"]
            for f in failed
        ), failed
    finally:
        import os as _os

        _os.unlink(broken_path)
        # Also nuke any pyc that may have been generated.
        cache_dir = f"{pkg_dir}/__pycache__"
        if _os.path.isdir(cache_dir):
            for entry in _os.listdir(cache_dir):
                if entry.startswith("_broken_for_tests"):
                    _os.unlink(f"{cache_dir}/{entry}")
        sys.modules.pop("money.ingest._broken_for_tests", None)


def test_probe_lists_skipped_modules() -> None:
    exit_code, output = _run_probe()
    assert exit_code == 0, output
    payload = json.loads(output)
    skipped = set(payload["skipped"])
    # `browser` isn't a real file in this repo but the registry's skip set
    # includes it defensively. The others should always show up because the
    # files exist.
    for expected in ("common", "registry", "schemas"):
        assert expected in skipped, skipped


def test_probe_json_default_parseable() -> None:
    exit_code, output = _run_probe()
    assert exit_code == 0, output
    payload = json.loads(output)  # MUST round-trip
    assert isinstance(payload, dict)
    assert {"registered", "failed", "skipped"}.issubset(payload.keys())
