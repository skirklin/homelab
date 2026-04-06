"""Wealthfront ingester — uses cookie relay + internal API."""

import json
import logging
import urllib.request
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from pydantic import ValidationError

from money.db import Database
from money.ingest.common import ts_to_date
from money.ingest.schemas import (
    WFOpenLotsResponse,
    WFOverviewsResponse,
    WFPerformanceResponse,
    WFTransfersWrapper,
)
from money.models import (
    AccountType,
    Balance,
    Holding,
    IngestionRecord,
    IngestionStatus,
    Transaction,
)
from money.storage import RawStore

log = logging.getLogger(__name__)

OVERVIEWS_URL = (
    "/capitan/v1/accounts/overviews2"
    "?filter_customer_account_states=INCOMPLETE"
    "&filter_customer_account_states=PENDING"
    "&filter_customer_account_states=OPENED"
    "&filter_customer_account_states=FUNDED"
    "&filter_customer_account_states=CLOSED"
    "&filter_customer_account_states=CLOSING"
)

ACCOUNT_TYPE_MAP: dict[str, AccountType] = {
    "INDIVIDUAL": AccountType.BROKERAGE,
    "JOINT": AccountType.BROKERAGE,
    "TRADITIONAL_IRA": AccountType.IRA,
    "ROTH_IRA": AccountType.IRA,
    "SEP_IRA": AccountType.IRA,
    "ROLLOVER_IRA": AccountType.IRA,
    "401K": AccountType.FOUR_OH_ONE_K,
    "CASH": AccountType.SAVINGS,
    "CHECKING": AccountType.CHECKING,
}



def _api_get(cookies: dict[str, str], path: str) -> Any:
    """Make an authenticated GET to Wealthfront's internal API."""
    url = f"https://www.wealthfront.com{path}"
    req = urllib.request.Request(url)
    req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ))
    if "xsrf" in cookies:
        req.add_header("x-csrf-token", unquote(cookies["xsrf"]))
    req.add_header("wf-session-id", str(uuid.uuid4()))
    req.add_header("wf-request-id", str(uuid.uuid4()))
    req.add_header("wf-guest-id", str(uuid.uuid4()))

    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())


def _resolve_account_type(wf_type: str) -> AccountType:
    """Map Wealthfront account type string to our AccountType."""
    return ACCOUNT_TYPE_MAP.get(wf_type, AccountType.BROKERAGE)


def _download_supplementary(
    cookies: dict[str, str],
    store: RawStore,
    acct_id: str,
    numeric_ids: dict[str, int],
    timestamp: str,
    profile: str | None = None,
) -> None:
    """Download and store supplementary data for an account."""
    prefix = f"wealthfront/{profile}/{timestamp}_{acct_id}"

    # Closed tax lots for current year
    try:
        lots_data = _api_get(
            cookies,
            f"/capitan/v1/accounts/{acct_id}/taxable-closed-lots-for-current-year",
        )
        store.put(f"{prefix}_closed_lots.json", json.dumps(lots_data, indent=2).encode())
        lot_count = len(lots_data.get("closedLotForDisplayList", []))
        log.info("  Stored %d closed tax lots", lot_count)
    except Exception as e:
        log.warning("  Could not fetch closed lots: %s", e)

    # Performance history (daily balances since inception)
    try:
        perf_data = _api_get(
            cookies,
            f"/capitan/v1/accounts/{acct_id}/performance?period_range_identifier=ALL",
        )
        store.put(f"{prefix}_performance.json", json.dumps(perf_data, indent=2).encode())
        history_len = len(perf_data.get("historyList", []))
        log.info("  Stored %d days of performance history", history_len)
    except Exception as e:
        log.warning("  Could not fetch performance: %s", e)

    # Tax savings summary
    try:
        tax_data = _api_get(cookies, f"/capitan/v1/tax-savings/{acct_id}")
        store.put(f"{prefix}_tax_savings.json", json.dumps(tax_data, indent=2).encode())
        years = len(tax_data.get("estimates", []))
        log.info("  Stored %d years of tax savings data", years)
    except Exception as e:
        log.warning("  Could not fetch tax savings: %s", e)

    # Open lots (current holdings with cost basis)
    try:
        open_lots_data = _api_get(
            cookies,
            f"/capitan/v1/accounts/{acct_id}/taxable-open-lots",
        )
        store.put(f"{prefix}_open_lots.json", json.dumps(open_lots_data, indent=2).encode())
        lot_count = len(open_lots_data.get("openLotForDisplayList", []))
        log.info("  Stored %d open lots (current holdings)", lot_count)
    except Exception as e:
        log.warning("  Could not fetch open lots: %s", e)

    # Combined dashboard data and transfers (need numeric ID)
    numeric_id = numeric_ids.get(acct_id)
    if numeric_id:
        try:
            dash_data = _api_get(
                cookies,
                f"/api/wealthfront_accounts/{numeric_id}"
                "/get_combined_data_for_account_dashboard",
            )
            store.put(f"{prefix}_dashboard.json", json.dumps(dash_data, indent=2).encode())
            log.info("  Stored dashboard data")
        except Exception as e:
            log.warning("  Could not fetch dashboard data: %s", e)

        try:
            transfers = _api_get(
                cookies,
                f"/api/transactions/{numeric_id}/transfers-for-account",
            )
            store.put(f"{prefix}_transfers.json", json.dumps(transfers, indent=2).encode())
            completed = transfers.get("transfers", {}).get("completed_transfers", [])
            log.info("  Stored %d completed transfers", len(completed))
        except Exception as e:
            log.warning("  Could not fetch transfers: %s", e)


def ingest_transfers(
    db: Database,
    account_id: str,
    transfers_data: WFTransfersWrapper,
    raw_file_ref: str,
) -> int:
    """Parse completed transfers into transactions."""
    completed = transfers_data.transfers.completed_transfers
    count = 0
    for t in completed:
        amount_str = t.amount.replace("$", "").replace(",", "")
        try:
            amount = float(amount_str)
        except ValueError:
            continue

        txn_date = date.fromisoformat(t.created_at[:10])

        desc_parts = [t.type]
        if t.initiator_name:
            desc_parts.append(t.initiator_name)
        description = " — ".join(desc_parts)

        db.insert_transaction(
            Transaction(
                account_id=account_id,
                date=txn_date,
                amount=amount,
                description=description,
                category=t.class_type,
                raw_file_ref=raw_file_ref,
            )
        )
        count += 1
    return count


def parse_raw_wealthfront(
    db: Database,
    inst_dir: Path,
    timestamp: str,
    profile: str | None,
) -> dict[str, int]:
    """Parse raw Wealthfront API captures for a given timestamp and write to DB.

    Reads:
      {inst_dir}/{timestamp}_overviews.json
      {inst_dir}/{timestamp}_{acct_id}_performance.json
      {inst_dir}/{timestamp}_{acct_id}_open_lots.json
      {inst_dir}/{timestamp}_{acct_id}_transfers.json

    Returns a summary dict with counts written.
    """
    as_of = ts_to_date(timestamp)

    overviews_data = WFOverviewsResponse.model_validate_json(
        (inst_dir / f"{timestamp}_overviews.json").read_text()
    )
    overviews = overviews_data.overviews
    account_count = 0

    for overview in overviews:
        acct_id = overview.accountId
        acct_type_str = overview.accountType
        display_name = overview.accountDisplayName
        state = overview.state
        total_value = overview.accountValueSummary.totalValue

        if state not in ("FUNDED", "OPENED"):
            continue

        account_type = ACCOUNT_TYPE_MAP.get(acct_type_str, AccountType.BROKERAGE)

        account = db.get_or_create_account(
            name=display_name,
            account_type=account_type,
            institution="wealthfront",
            external_id=acct_id,
            profile=profile,
        )
        account_count += 1
        log.info("Wealthfront: %s [%s] %s", display_name, acct_id, account_type.value)

        db.insert_balance(
            Balance(
                account_id=account.id,
                as_of=as_of,
                balance=total_value,
                source="wealthfront_api",
                raw_file_ref=f"wealthfront/{profile}/{timestamp}_overviews.json",
            )
        )

        # Performance history
        perf_path = inst_dir / f"{timestamp}_{acct_id}_performance.json"
        perf_data: WFPerformanceResponse | None = (
            WFPerformanceResponse.model_validate_json(perf_path.read_text())
            if perf_path.exists()
            else None
        )
        if perf_data:
            perf_rows: list[tuple[str, str, float, float | None, float | None]] = []
            for entry in perf_data.historyList:
                earned = entry.marketValue - entry.sumNetDeposits
                perf_rows.append((
                    account.id,
                    entry.date,
                    entry.marketValue,
                    entry.sumNetDeposits,
                    earned,
                ))
            if perf_rows:
                db.insert_performance_batch(perf_rows)
                log.info("  Performance history: %d points", len(perf_rows))

        # Holdings from open lots
        lots_path = inst_dir / f"{timestamp}_{acct_id}_open_lots.json"
        lots_data: WFOpenLotsResponse | None = (
            WFOpenLotsResponse.model_validate_json(lots_path.read_text())
            if lots_path.exists()
            else None
        )
        if lots_data:
            by_symbol: dict[str, dict[str, float]] = {}
            for lot in lots_data.openLotForDisplayList:
                sym = lot.symbol
                if sym not in by_symbol:
                    by_symbol[sym] = {"shares": 0.0, "value": 0.0, "cost_basis": 0.0}
                by_symbol[sym]["shares"] += lot.quantity
                by_symbol[sym]["value"] += lot.currentValue
                by_symbol[sym]["cost_basis"] += lot.costBasis

            open_lots_key = f"wealthfront/{profile}/{timestamp}_{acct_id}_open_lots.json"
            holding_rows: list[Holding] = []
            for sym, agg in by_symbol.items():
                if agg["shares"] > 0:
                    holding_rows.append(Holding(
                        account_id=account.id,
                        as_of=as_of,
                        symbol=sym,
                        name=sym,
                        shares=agg["shares"],
                        value=agg["value"],
                        source="wealthfront_api",
                        raw_file_ref=open_lots_key,
                    ))
            if holding_rows:
                db.insert_holdings_batch(holding_rows)
                log.info("  Holdings: %d positions", len(holding_rows))

        # Transfers as transactions
        transfers_path = inst_dir / f"{timestamp}_{acct_id}_transfers.json"
        transfers_data: WFTransfersWrapper | None = None
        if transfers_path.exists():
            try:
                transfers_data = WFTransfersWrapper.model_validate_json(
                    transfers_path.read_text()
                )
            except ValidationError:
                log.warning(
                    "  Skipping transfers file (invalid/error response): %s",
                    transfers_path.name,
                )
        if transfers_data:
            transfers_key = f"wealthfront/{profile}/{timestamp}_{acct_id}_transfers.json"
            txn_count = ingest_transfers(db, account.id, transfers_data, transfers_key)
            if txn_count:
                log.info("  Transfers: %d transactions", txn_count)

    log.info("Wealthfront: parsed snapshot %s (%d accounts)", timestamp, len(overviews))
    return {"accounts": account_count}


def sync_wealthfront(db: Database, store: RawStore, profile: str,
                     cookies: dict[str, str]) -> None:
    """Sync Wealthfront accounts and balances via internal API."""
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")

    try:
        log.info("Loaded %d cookies for Wealthfront (login: %s)", len(cookies), profile)

        data = _api_get(cookies, OVERVIEWS_URL)
        overviews = data.get("overviews", [])
        log.info("Got %d account(s) from Wealthfront API", len(overviews))

        # Store the raw API response
        raw_key = f"wealthfront/{profile}/{timestamp}_overviews.json"
        store.put(raw_key, json.dumps(data, indent=2).encode())

        # Store external accounts (linked accounts from other institutions)
        try:
            external = _api_get(cookies, "/api/external_accounts")
            store.put(
                f"wealthfront/{profile}/{timestamp}_external_accounts.json",
                json.dumps(external, indent=2).encode(),
            )
            link_count = len(external.get("linkStatuses", []))
            log.info("Stored %d external account links", link_count)
        except Exception as e:
            log.warning("Could not fetch external accounts: %s", e)

        # Get numeric ID mapping for all accounts
        all_acct_ids = [o["accountId"] for o in overviews if o.get("accountId")]
        numeric_ids: dict[str, int] = {}
        if all_acct_ids:
            try:
                ids_param = "&".join(f"accountIds={a}" for a in all_acct_ids)
                id_data = _api_get(
                    cookies,
                    f"/api/wealthfront_accounts/get_account_ids_for_user?{ids_param}",
                )
                numeric_ids = id_data.get("data", {})
            except Exception as e:
                log.warning("Could not fetch numeric account IDs: %s", e)

        for overview in overviews:
            acct_id = overview.get("accountId", "")
            display_name = overview.get("accountDisplayName", f"Account {acct_id}")
            state = overview.get("state", "")

            if not acct_id:
                log.warning("Skipping account with no ID: %s", overview)
                continue

            if state not in ("FUNDED", "OPENED"):
                log.info("Skipping %s account: %s [%s]", state, display_name, acct_id)
                continue

            # Download supplementary data
            _download_supplementary(cookies, store, acct_id, numeric_ids, timestamp, profile)

        # Parse all raw data and write to DB
        from money.config import DATA_DIR as _DATA_DIR
        inst_dir = _DATA_DIR / "raw" / "wealthfront" / (profile or "default")
        parse_raw_wealthfront(db, inst_dir, timestamp, profile)

        db.insert_ingestion_record(
            IngestionRecord(
                source="wealthfront",
                profile=profile,
                status=IngestionStatus.SUCCESS,
                raw_file_ref=raw_key,
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )

    except Exception as e:
        log.error("Wealthfront sync failed: %s", e)
        db.insert_ingestion_record(
            IngestionRecord(
                source="wealthfront",
                profile=profile,
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise


from money.ingest.registry import InstitutionInfo  # noqa: E402

INSTITUTION = InstitutionInfo(
    name="wealthfront",
    dir_name="wealthfront",
    sync_fn=sync_wealthfront,
    parse_fn=parse_raw_wealthfront,
    anchor_file="overviews.json",
    display_name="Wealthfront",
)
