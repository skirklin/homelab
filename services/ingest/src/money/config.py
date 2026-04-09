import json
from dataclasses import dataclass, field
from pathlib import Path

# Project-local data directory (gitignored)
PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = PROJECT_DIR / ".data"
DB_PATH = DATA_DIR / "money.db"
COOKIE_RELAY_DIR = DATA_DIR / "cookies"
RAW_STORE_DIR = DATA_DIR / "raw"
DEBUG_DIR = DATA_DIR / "debug"

# User config: check data dir first (persists in PVC), fall back to ~/.config/money/
_USER_CONFIG_DIR = Path.home() / ".config" / "money"
CONFIG_FILE = _USER_CONFIG_DIR / "config.json"  # legacy default


def _resolve_config_file() -> Path:
    """Return the config file path, preferring the data dir (PVC-persisted)."""
    data_config = DATA_DIR / "config.json"
    if data_config.exists():
        return data_config
    return CONFIG_FILE


@dataclass
class PersonConfig:
    name: str


@dataclass
class LoginConfig:
    person: str
    institution: str


@dataclass
class InstitutionConfig:
    label: str = ""
    url: str | None = None


@dataclass
class AppConfig:
    institutions: dict[str, InstitutionConfig]
    logins: dict[str, LoginConfig] = field(default_factory=lambda: dict[str, LoginConfig]())
    people: dict[str, PersonConfig] = field(default_factory=lambda: dict[str, PersonConfig]())


def load_config() -> AppConfig:
    config_path = _resolve_config_file()
    if not config_path.exists():
        msg = (
            f"Config file not found. Checked:\n"
            f"  - {DATA_DIR / 'config.json'} (PVC/data dir)\n"
            f"  - {CONFIG_FILE} (user config dir)\n"
            f"Create one with institution and login mappings."
        )
        raise FileNotFoundError(msg)

    raw = json.loads(config_path.read_text())

    institutions: dict[str, InstitutionConfig] = {}
    for inst_name, inst_data in raw.get("institutions", {}).items():
        institutions[inst_name] = InstitutionConfig(
            label=inst_data.get("label", inst_name),
            url=inst_data.get("url"),
        )

    people: dict[str, PersonConfig] = {}
    for person_id, person_data in raw.get("people", {}).items():
        people[person_id] = PersonConfig(name=person_data.get("name", person_id))

    logins: dict[str, LoginConfig] = {}
    for login_id, login_data in raw.get("logins", {}).items():
        logins[login_id] = LoginConfig(
            person=login_data["person"],
            institution=login_data["institution"],
        )

    return AppConfig(
        institutions=institutions,
        people=people,
        logins=logins,
    )


def resolve_login_id(institution: str, profile: str) -> str:
    """Resolve a login_id from institution + profile.

    Accepts either a bare person name (e.g. "scott") or a full login_id
    (e.g. "scott@ally"). Returns the canonical login_id.
    """
    if "@" in profile:
        return profile  # already a full login_id
    return f"{profile}@{institution}"


def cookie_relay_path(institution: str, profile: str | None = None) -> Path:
    COOKIE_RELAY_DIR.mkdir(parents=True, exist_ok=True)
    if profile:
        login_id = resolve_login_id(institution, profile)
        return COOKIE_RELAY_DIR / f"{login_id}.json"
    return COOKIE_RELAY_DIR / f"{institution}.json"


def debug_dir() -> Path:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    return DEBUG_DIR
