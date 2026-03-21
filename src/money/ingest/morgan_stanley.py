"""Morgan Stanley Shareworks ingester — uses JWT from network log + REST API."""

import contextlib
import json
import logging
import urllib.error
import urllib.request
from datetime import date, datetime
from typing import Any

from money.config import DATA_DIR
from money.db import Database
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
        portfolio_data: dict[str, Any] | None = None
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
        raw_grants: list[dict[str, Any]] = grants_data.get("data", [])

        # Extract stock prices
        stock_price_str: str = summary.get("companyStockPrice", "0 USD")
        fmv_price_str: str = summary.get("valuedAtPrice", "0 USD")
        stock_price = parse_money(stock_price_str)
        fmv_price = parse_money(fmv_price_str)
        price_label: str = summary.get("marketPriceLabel", "")

        log.info(
            "Stock price: $%.2f, 409A FMV: $%.4f (label: %s)",
            stock_price, fmv_price, price_label,
        )

        # Create account
        account = db.get_or_create_account(
            name="Anthropic Stock Options",
            account_type=AccountType.STOCK_OPTIONS,
            institution="morgan_stanley",
            external_id="shareworks",
        )
        log.info("Account: %s (id=%s)", account.name, account.id)

        # 4. Record total balance
        total_value: float | None = None
        if portfolio_data:
            accounts_list: list[dict[str, Any]] = portfolio_data.get("accounts", [])
            if accounts_list:
                total_value = float(accounts_list[0].get("totalValue", {}).get("amount", 0))
        else:
            # Fall back to summing available + future from portfolio summary
            portfolio_items: list[dict[str, Any]] = summary.get("portfolioData", [])
            available_total = 0.0
            future_total = 0.0
            for item in portfolio_items:
                av: str = item.get("availableValue", "0 USD")
                available_total += parse_money(av)
                future_list: list[dict[str, Any]] = item.get("futureData", [])
                for f in future_list:
                    fv: str = f.get("value", "0 USD")
                    future_total += parse_money(fv)
            total_value = available_total + future_total

        if total_value is not None:
            db.insert_balance(
                Balance(
                    account_id=account.id,
                    as_of=date.today(),
                    balance=total_value,
                    source="morgan_stanley_api",
                    raw_file_ref=raw_key,
                )
            )
            log.info("Balance: $%.2f", total_value)

        # 5. Record FMV (409A valuation)
        if fmv_price > 0:
            db.insert_private_valuation(
                PrivateValuation(
                    account_id=account.id,
                    as_of=date.today(),
                    fmv_per_share=fmv_price,
                    source="shareworks_409a",
                )
            )
            log.info("Recorded 409A FMV: $%.4f/share", fmv_price)

        # 6. Build vested quantity lookup from portfolio summary
        # The portfolio summary has availableQuantity/availableValue per grant
        portfolio_data: list[dict[str, Any]] = list(
            summary_data.get("portfolioData", [])
        )
        vested_by_instance: dict[str, tuple[int, float]] = {}
        for pd in portfolio_data:
            instance_name: str = pd.get("instanceName", "")
            avail_qty = int(pd.get("availableQuantity", 0))
            avail_val = parse_money(pd.get("availableValue", "0 USD"))
            if instance_name:
                vested_by_instance[instance_name] = (avail_qty, avail_val)

        # 7. Record individual grants with vested data from portfolio summary
        grant_count = 0
        for raw_grant in raw_grants:
            grant_date_str: str = raw_grant.get("grantDate", "")
            if not grant_date_str:
                continue

            grant_date = date.fromisoformat(grant_date_str)
            award_name: str = raw_grant.get("awardName", "")
            grant_name: str = raw_grant.get("grantName", "")
            grant_number: str = raw_grant.get("grantNumber", "")
            quantity: int = int(raw_grant.get("quantityGranted", 0))
            expiration_str: str | None = raw_grant.get("expiredDate")

            # Extract strike price from grant name (e.g. "02/05/2024 - ISO - $12.98")
            strike_price = 0.0
            parts = grant_name.split("$")
            if len(parts) > 1:
                price_str = parts[-1].split()[0].rstrip(" -")
                with contextlib.suppress(ValueError):
                    strike_price = float(price_str)

            exercise_details: dict[str, Any] = raw_grant.get("exerciseDetails", {})
            vest_dates: list[str] = exercise_details.get("vestDates", [])
            parsed_vest_dates = [date.fromisoformat(d) for d in vest_dates]

            grant_type = determine_grant_type(award_name)

            # Look up vested quantity from portfolio summary
            vested_qty, vested_val = vested_by_instance.get(grant_name, (0, 0.0))

            expiration_date = date.fromisoformat(expiration_str) if expiration_str else None

            db.insert_option_grant(
                OptionGrant(
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
                "  Grant %s: %s %s, %d shares @ $%.2f, %d vested ($%,.0f)",
                grant_number, grant_type, grant_date, quantity, strike_price,
                vested_qty, vested_val,
            )

        log.info("Stored %d new grant(s)", grant_count)

        db.insert_ingestion_record(
            IngestionRecord(
                source="morgan_stanley",
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
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise
