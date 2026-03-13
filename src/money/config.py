import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

# Project-local data directory (gitignored)
PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = PROJECT_DIR / ".data"
BROWSER_STATE_DIR = DATA_DIR / "browser_state"
COOKIE_RELAY_DIR = DATA_DIR / "cookies"
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
class ProfileConfig:
    op_item: str
    vault: str = DEFAULT_VAULT


@dataclass
class InstitutionConfig:
    profiles: dict[str, ProfileConfig] = field(default_factory=lambda: dict[str, ProfileConfig]())


@dataclass
class AppConfig:
    institutions: dict[str, InstitutionConfig]
    gcs_bucket: str | None = None
    gcs_project: str | None = None


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
                {
                    "institutions": {
                        "ally": {
                            "profiles": {
                                "scott": {"op_item": "Ally", "vault": "Finances"}
                            }
                        }
                    }
                },
                indent=2,
            )
        )
        raise FileNotFoundError(msg)

    raw = json.loads(CONFIG_FILE.read_text())
    institutions: dict[str, InstitutionConfig] = {}
    for inst_name, inst_data in raw.get("institutions", {}).items():
        profiles: dict[str, ProfileConfig] = {}
        for prof_name, prof_data in inst_data.get("profiles", {}).items():
            profiles[prof_name] = ProfileConfig(
                op_item=prof_data["op_item"],
                vault=prof_data.get("vault", DEFAULT_VAULT),
            )
        institutions[inst_name] = InstitutionConfig(profiles=profiles)

    return AppConfig(
        institutions=institutions,
        gcs_bucket=raw.get("gcs_bucket"),
        gcs_project=raw.get("gcs_project"),
    )


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


def load_credentials(institution: str, profile: str) -> Credentials:
    config = load_config()
    if institution not in config.institutions:
        raise KeyError(f"No institution '{institution}' in {CONFIG_FILE}.")
    inst = config.institutions[institution]
    if profile not in inst.profiles:
        available = ", ".join(inst.profiles) or "(none)"
        raise KeyError(
            f"No profile '{profile}' for '{institution}' in {CONFIG_FILE}. "
            f"Available profiles: {available}"
        )

    prof = inst.profiles[profile]
    username = _op_read(prof.vault, prof.op_item, "username")
    password = _op_read(prof.vault, prof.op_item, "password")
    return Credentials(username=username, password=password)


def browser_state_path(institution: str, profile: str) -> Path:
    BROWSER_STATE_DIR.mkdir(parents=True, exist_ok=True)
    return BROWSER_STATE_DIR / f"{institution}_{profile}.json"


def cookie_relay_path(institution: str, profile: str | None = None) -> Path:
    COOKIE_RELAY_DIR.mkdir(parents=True, exist_ok=True)
    if profile:
        return COOKIE_RELAY_DIR / f"{institution}_{profile}.json"
    return COOKIE_RELAY_DIR / f"{institution}.json"


def debug_dir() -> Path:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    return DEBUG_DIR
