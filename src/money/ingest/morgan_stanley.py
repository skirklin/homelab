"""Morgan Stanley Shareworks ingester — uses JWT from network log + REST API."""

import contextlib
import json
import logging
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path
from typing import Any

from money.config import DATA_DIR
from money.db import Database
from money.ingest.common import ts_to_date
from money.models import (
    AccountType,
    Balance,
    IngestionRecord,
    IngestionStatus,
    OptionGrant,
    PrivateValuation,
)
from money.storage import RawStore

log = logging.getLogger(__name__)

BASE_URL = "https://shareworks.solium.com"

# REST v2 endpoints (Bearer JWT auth)
PORTFOLIO_SUMMARY_PATH = "/rest/participant/v2/portfolio/summary"
GRANTS_PATH = "/rest/participant/v2/grants"

# Legacy API endpoints (session UUID auth)
LINKED_PORTFOLIO_PATH = "/sw-ptpapi/v1/linkedAccount/portfolio"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/145.0.0.0 Safari/537.36"
)


def _load_auth_from_network_log() -> tuple[str, str]:
    """Extract JWT and session UUID from the most recent Morgan Stanley network log.

    Returns (bearer_token, session_uuid).
    """
    log_dir = DATA_DIR / "network_logs"
    if not log_dir.exists():
        raise FileNotFoundError("No network logs directory found.")

    logs = sorted(log_dir.glob("morgan_stanley_*.json"))
    if not logs:
        raise FileNotFoundError(
            "No Morgan Stanley network logs found. Record a session in Chrome first."
        )

    latest = logs[-1]
    log.info("Using network log: %s", latest.name)
    data = json.loads(latest.read_text())

    bearer_token: str | None = None
    session_uuid: str | None = None

    for entry in data.get("entries", []):
        headers: dict[str, str] = entry.get("requestHeaders", {})
        auth: str = headers.get("Authorization", headers.get("authorization", ""))

        if auth.startswith("Bearer ") and bearer_token is None:
            bearer_token = auth[7:]  # strip "Bearer " prefix
        elif auth and not auth.startswith("Bearer ") and session_uuid is None and len(auth) < 200:
            session_uuid = auth

    if not bearer_token:
        raise ValueError("Could not find Bearer JWT in network log headers.")
    if not session_uuid:
        log.warning("No session UUID in network log — legacy API calls skipped.")
        session_uuid = ""

    return bearer_token, session_uuid


def _api_get_bearer(token: str, path: str) -> Any:
    """Make an authenticated GET to Shareworks REST v2 API."""
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Cache-Control", "no-cache")

    try:
        resp = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        log.error("HTTP %d on %s: %s", e.code, path, body)
        raise
    return json.loads(resp.read())


def _api_get_session(session_uuid: str, path: str) -> Any:
    """Make an authenticated GET to Shareworks legacy API (sw-ptpapi)."""
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url)
    req.add_header("Authorization", session_uuid)
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Cache-Control", "no-cache")

    try:
        resp = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        log.error("HTTP %d on %s: %s", e.code, path, body)
        raise
    return json.loads(resp.read())


def parse_money(value: str) -> float:
    """Parse a Shareworks money string like '33671988.06 USD' to float."""
    return float(value.split()[0])


def determine_grant_type(award_name: str) -> str:
    """Classify a Shareworks award name into ISO, NQ, or RSU."""
    name = award_name.lower()
    if "iso" in name:
        return "ISO"
    if "nq" in name or "nqso" in name:
        return "NQ"
    if "rsu" in name:
        return "RSU"
    return award_name


def parse_raw_morgan_stanley(
    db: Database,
    inst_dir: Path,
    timestamp: str,
    profile: str | None,
) -> dict[str, int]:
    """Parse raw Morgan Stanley captures for a given timestamp and write to DB.

    Reads:
      {inst_dir}/{timestamp}_portfolio_summary.json
      {inst_dir}/{timestamp}_grants.json
      {inst_dir}/{timestamp}_portfolio.json   (optional legacy)

    Returns a summary dict with counts written.
    """
    as_of = ts_to_date(timestamp)

    from money.ingest.schemas import (
        MSGrant,
        MSGrantsResponse,
        MSPortfolioItem,
        MSPortfolioSummary,
        MSPortfolioSummaryResponse,
    )

    summary_response: MSPortfolioSummaryResponse = json.loads(
        (inst_dir / f"{timestamp}_portfolio_summary.json").read_text()
    )
    grants_response: MSGrantsResponse = json.loads(
        (inst_dir / f"{timestamp}_grants.json").read_text()
    )
    summary: MSPortfolioSummary = summary_response["data"]
    raw_grants: list[MSGrant] = grants_response["data"]

    fmv_price = parse_money(summary["valuedAtPrice"])

    account = db.get_or_create_account(
        name="Anthropic Stock Options",
        account_type=AccountType.STOCK_OPTIONS,
        institution="morgan_stanley",
        external_id="shareworks",
        profile=profile,
    )

    # Total balance from portfolio summary
    portfolio_items: list[MSPortfolioItem] = summary["portfolioData"]
    available_total = 0.0
    future_total = 0.0
    for item in portfolio_items:
        available_total += parse_money(item["availableValue"])
        for f in item["futureData"]:
            future_total += parse_money(f["value"])
    total_value = available_total + future_total

    raw_key = f"morgan_stanley/{timestamp}_portfolio_summary.json"

    db.insert_balance(
        Balance(
            account_id=account.id,
            as_of=as_of,
            balance=total_value,
            source="morgan_stanley_api",
            raw_file_ref=raw_key,
        )
    )

    # FMV (409A valuation)
    if fmv_price > 0:
        db.insert_private_valuation(
            PrivateValuation(
                account_id=account.id,
                as_of=as_of,
                fmv_per_share=fmv_price,
                source="shareworks_409a",
            )
        )

    # Build vested quantity lookup from portfolio summary
    vested_by_instance: dict[str, tuple[int, float]] = {}
    for pi in portfolio_items:
        instance_name: str = pi["instanceName"]
        avail_qty = int(pi["availableQuantity"])
        avail_val = parse_money(pi["availableValue"])
        vested_by_instance[instance_name] = (avail_qty, avail_val)

    # Grants
    grant_count = 0
    for raw_grant in raw_grants:
        grant_date = date.fromisoformat(raw_grant["grantDate"])
        award_name: str = raw_grant["awardName"]
        grant_name: str = raw_grant["grantName"]
        grant_number: str = raw_grant["grantNumber"]
        quantity = int(raw_grant["quantityGranted"])
        expiration_str: str | None = raw_grant.get("expiredDate")

        # Extract strike price from grant name (e.g. "02/05/2024 - ISO - $12.98")
        strike_price = 0.0
        parts = grant_name.split("$")
        if len(parts) > 1:
            price_str = parts[-1].split()[0].rstrip(" -")
            with contextlib.suppress(ValueError):
                strike_price = float(price_str)

        exercise_details = raw_grant["exerciseDetails"]
        vest_dates = exercise_details["vestDates"]
        parsed_vest_dates = [date.fromisoformat(d) for d in vest_dates]

        grant_type = determine_grant_type(award_name)
        vested_qty, vested_val = vested_by_instance.get(grant_name, (0, 0.0))
        expiration_date = date.fromisoformat(expiration_str) if expiration_str else None

        db.insert_option_grant(
            OptionGrant(
                id=grant_number,
                account_id=account.id,
                grant_date=grant_date,
                grant_type=grant_type,
                total_shares=quantity,
                vested_shares=vested_qty,
                strike_price=strike_price,
                vested_value=vested_val,
                expiration_date=expiration_date,
                vest_dates=parsed_vest_dates,
            )
        )
        grant_count += 1
        log.info(
            "  Grant %s: %s %s, %d shares @ $%.2f, %d vested ($%.0f)",
            grant_number, grant_type, grant_date, quantity, strike_price,
            vested_qty, vested_val,
        )

    log.info("Morgan Stanley: parsed snapshot %s (%d grants)", timestamp, grant_count)
    return {"grants": grant_count}


def sync_morgan_stanley(
    db: Database,
    store: RawStore,
    profile: str | None = None,
) -> None:
    """Sync Morgan Stanley Shareworks stock option/RSU data."""
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")
    raw_key = f"morgan_stanley/{timestamp}_portfolio_summary.json"

    try:
        bearer_token, session_uuid = _load_auth_from_network_log()
        log.info("Loaded auth tokens from network log")

        # 1. Fetch portfolio overview (for total value)
        if session_uuid:
            try:
                portfolio_data = _api_get_session(session_uuid, LINKED_PORTFOLIO_PATH)
                store.put(
                    f"morgan_stanley/{timestamp}_portfolio.json",
                    json.dumps(portfolio_data, indent=2).encode(),
                )
            except Exception as e:
                log.warning("Could not fetch linked portfolio (session may be expired): %s", e)

        # 2. Fetch portfolio summary (per-award breakdown with values)
        summary_data = _api_get_bearer(bearer_token, PORTFOLIO_SUMMARY_PATH)
        store.put(raw_key, json.dumps(summary_data, indent=2).encode())

        # 3. Fetch grants (detailed grant info)
        grants_data = _api_get_bearer(bearer_token, GRANTS_PATH)
        store.put(
            f"morgan_stanley/{timestamp}_grants.json",
            json.dumps(grants_data, indent=2).encode(),
        )

        summary: dict[str, Any] = summary_data.get("data", {})
        stock_price_str: str = summary.get("companyStockPrice", "0 USD")
        fmv_price_str: str = summary.get("valuedAtPrice", "0 USD")
        stock_price = parse_money(stock_price_str)
        fmv_price = parse_money(fmv_price_str)
        price_label: str = summary.get("marketPriceLabel", "")

        log.info(
            "Stock price: $%.2f, 409A FMV: $%.4f (label: %s)",
            stock_price, fmv_price, price_label,
        )

        # Parse all raw data and write to DB
        from money.config import DATA_DIR as _DATA_DIR
        inst_dir = _DATA_DIR / "raw" / "morgan_stanley"
        parse_raw_morgan_stanley(db, inst_dir, timestamp, profile)

        db.insert_ingestion_record(
            IngestionRecord(
                source="morgan_stanley",
                profile=profile,
                status=IngestionStatus.SUCCESS,
                raw_file_ref=raw_key,
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        log.info("Morgan Stanley sync complete")

    except Exception as e:
        log.error("Morgan Stanley sync failed: %s", e)
        db.insert_ingestion_record(
            IngestionRecord(
                source="morgan_stanley",
                profile=profile,
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise
