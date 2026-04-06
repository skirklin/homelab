import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

# Project-local data directory (gitignored)
PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = PROJECT_DIR / ".data"
DB_PATH = DATA_DIR / "money.db"
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
class PersonConfig:
    name: str


@dataclass
class LoginConfig:
    person: str
    institution: str
    op_item: str | None = None
    vault: str | None = None


@dataclass
class InstitutionConfig:
    label: str = ""
    url: str | None = None
    auth: str = "cookies"


@dataclass
class AppConfig:
    institutions: dict[str, InstitutionConfig]
    logins: dict[str, LoginConfig] = field(default_factory=lambda: dict[str, LoginConfig]())
    people: dict[str, PersonConfig] = field(default_factory=lambda: dict[str, PersonConfig]())
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
            f"Create it with institution and login mappings, e.g.:\n"
            + json.dumps(
                {
                    "institutions": {
                        "ally": {"label": "Ally Bank", "auth": "playwright"}
                    },
                    "logins": {
                        "scott@ally": {
                            "person": "scott",
                            "institution": "ally",
                            "op_item": "Ally",
                            "vault": "Finances",
                        }
                    },
                },
                indent=2,
            )
        )
        raise FileNotFoundError(msg)

    raw = json.loads(CONFIG_FILE.read_text())

    institutions: dict[str, InstitutionConfig] = {}
    for inst_name, inst_data in raw.get("institutions", {}).items():
        institutions[inst_name] = InstitutionConfig(
            label=inst_data.get("label", inst_name),
            url=inst_data.get("url"),
            auth=inst_data.get("auth", "cookies"),
        )

    people: dict[str, PersonConfig] = {}
    for person_id, person_data in raw.get("people", {}).items():
        people[person_id] = PersonConfig(name=person_data.get("name", person_id))

    logins: dict[str, LoginConfig] = {}
    for login_id, login_data in raw.get("logins", {}).items():
        logins[login_id] = LoginConfig(
            person=login_data["person"],
            institution=login_data["institution"],
            op_item=login_data.get("op_item"),
            vault=login_data.get("vault"),
        )

    return AppConfig(
        institutions=institutions,
        people=people,
        logins=logins,
        gcs_bucket=raw.get("gcs_bucket"),
        gcs_project=raw.get("gcs_project"),
    )


def resolve_login_id(institution: str, profile: str) -> str:
    """Resolve a login_id from institution + profile.

    Accepts either a bare person name (e.g. "scott") or a full login_id
    (e.g. "scott@ally"). Returns the canonical login_id.
    """
    if "@" in profile:
        return profile  # already a full login_id
    return f"{profile}@{institution}"


def _op_read(vault: str, item: str, field_name: str) -> str:
    _load_env()
    result = subprocess.run(
        ["op", "read", f"op://{vault}/{item}/{field_name}"],
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
    """Load credentials for a login.

    Args:
        institution: Institution key (e.g. "ally").
        profile: Either a bare person name (e.g. "scott") or a full login_id
                 (e.g. "scott@ally"). Bare names are resolved to login_ids.
    """
    config = load_config()
    login_id = resolve_login_id(institution, profile)

    if login_id not in config.logins:
        available = ", ".join(
            lid for lid in config.logins if config.logins[lid].institution == institution
        ) or "(none)"
        raise KeyError(
            f"No login '{login_id}' in {CONFIG_FILE}. "
            f"Available logins for '{institution}': {available}"
        )

    login = config.logins[login_id]
    if not login.op_item or not login.vault:
        raise KeyError(
            f"Login '{login_id}' has no op_item/vault — cannot load credentials from 1Password."
        )

    username = _op_read(login.vault, login.op_item, "username")
    password = _op_read(login.vault, login.op_item, "password")
    return Credentials(username=username, password=password)


def browser_state_path(institution: str, profile: str) -> Path:
    login_id = resolve_login_id(institution, profile)
    BROWSER_STATE_DIR.mkdir(parents=True, exist_ok=True)
    return BROWSER_STATE_DIR / f"{login_id}.json"


def cookie_relay_path(institution: str, profile: str | None = None) -> Path:
    COOKIE_RELAY_DIR.mkdir(parents=True, exist_ok=True)
    if profile:
        login_id = resolve_login_id(institution, profile)
        return COOKIE_RELAY_DIR / f"{login_id}.json"
    return COOKIE_RELAY_DIR / f"{institution}.json"


def debug_dir() -> Path:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    return DEBUG_DIR
