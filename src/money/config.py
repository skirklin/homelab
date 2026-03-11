import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Project-local data directory (gitignored)
PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = PROJECT_DIR / ".data"
BROWSER_STATE_DIR = DATA_DIR / "browser_state"
RAW_STORE_DIR = DATA_DIR / "raw"
DEBUG_DIR = DATA_DIR / "debug"

# User config lives in ~/.config/money/
CONFIG_DIR = Path.home() / ".config" / "money"
CONFIG_FILE = CONFIG_DIR / "config.json"
ENV_FILE = CONFIG_DIR / ".env"

DEFAULT_VAULT = "Personal"


@dataclass
class Credentials:
    username: str
    password: str


@dataclass
class InstitutionConfig:
    op_item: str
    vault: str = DEFAULT_VAULT


@dataclass
class AppConfig:
    institutions: dict[str, InstitutionConfig]


def _load_env() -> None:
    """Load environment variables from the .env file if present."""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        if key and value:
            os.environ.setdefault(key.strip(), value.strip())


def load_config() -> AppConfig:
    if not CONFIG_FILE.exists():
        msg = (
            f"Config file not found at {CONFIG_FILE}. "
            f"Create it with institution mappings, e.g.:\n"
            + json.dumps(
                {"institutions": {"ally": {"op_item": "Ally"}}},
                indent=2,
            )
        )
        raise FileNotFoundError(msg)

    raw = json.loads(CONFIG_FILE.read_text())
    raw_institutions: dict[str, dict[str, str]] = raw.get("institutions", {})

    institutions: dict[str, InstitutionConfig] = {}
    for key in raw_institutions:
        entry = raw_institutions[key]
        institutions[key] = InstitutionConfig(
            op_item=entry["op_item"],
            vault=entry.get("vault", DEFAULT_VAULT),
        )

    return AppConfig(institutions=institutions)


def _op_read(vault: str, item: str, field: str) -> str:
    _load_env()
    result = subprocess.run(
        ["op", "read", f"op://{vault}/{item}/{field}"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"1Password read failed: {result.stderr.strip()}\n"
            f"Ensure OP_SERVICE_ACCOUNT_TOKEN is set in {ENV_FILE}"
        )
    return result.stdout.strip()


def credential_key(institution: str, profile: str | None = None) -> str:
    """Return the config key for an institution/profile pair."""
    return f"{institution}:{profile}" if profile else institution


def load_credentials(institution: str, profile: str | None = None) -> Credentials:
    config = load_config()
    key = credential_key(institution, profile)
    if key not in config.institutions:
        raise KeyError(
            f"No config for '{key}' in {CONFIG_FILE}. "
            f"Add it under 'institutions' with an 'op_item' key."
        )

    inst = config.institutions[key]
    username = _op_read(inst.vault, inst.op_item, "username")
    password = _op_read(inst.vault, inst.op_item, "password")
    return Credentials(username=username, password=password)


def browser_state_path(institution: str, profile: str | None = None) -> Path:
    BROWSER_STATE_DIR.mkdir(parents=True, exist_ok=True)
    key = credential_key(institution, profile)
    return BROWSER_STATE_DIR / f"{key}.json"


def debug_dir() -> Path:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    return DEBUG_DIR
