"""Wealthfront ingester — uses cookie relay + internal API."""

import json
import logging
import urllib.request
import uuid
from datetime import date, datetime
from typing import Any
from urllib.parse import unquote

from money.config import cookie_relay_path
from money.db import Database
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


def _load_cookies(profile: str | None = None) -> dict[str, str]:
    """Load relayed cookies from the Chrome extension."""
    path = (
        cookie_relay_path("wealthfront", profile) if profile else cookie_relay_path("wealthfront")
    )
    if not path.exists() and profile:
        # Fall back to institution-level cookie file
        path = cookie_relay_path("wealthfront")
    if not path.exists():
        raise FileNotFoundError(
            "No cookies found for wealthfront. Log into Wealthfront in Chrome and "
            "click the Cookies button in the extension."
        )

    data = json.loads(path.read_text())
    cookies: dict[str, str] = {}
    for c in data.get("cookies", []):
        cookies[c["name"]] = c["value"]

    if "token" not in cookies or "xsrf" not in cookies:
        raise ValueError("Cookie file missing 'token' or 'xsrf' — recapture from extension.")

    return cookies


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
) -> None:
    """Download and store supplementary data for an account."""
    prefix = f"wealthfront/{timestamp}_{acct_id}"

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
    transfers_data: dict[str, Any],
    raw_file_ref: str,
) -> int:
    """Parse completed transfers into transactions."""
    completed = transfers_data.get("transfers", {}).get("completed_transfers", [])
    count = 0
    for t in completed:
        amount_str = t.get("amount", "$0").replace("$", "").replace(",", "")
        try:
            amount = float(amount_str)
        except ValueError:
            continue

        created = t.get("created_at", "")
        if not created:
            continue
        txn_date = date.fromisoformat(created[:10])

        desc_parts = [t.get("type", "")]
        if t.get("initiator_name"):
            desc_parts.append(t["initiator_name"])
        description = " — ".join(p for p in desc_parts if p)

        db.insert_transaction(
            Transaction(
                account_id=account_id,
                date=txn_date,
                amount=amount,
                description=description,
                category=t.get("class_type"),
                raw_file_ref=raw_file_ref,
            )
        )
        count += 1
    return count


def sync_wealthfront(db: Database, store: RawStore, profile: str | None = None) -> None:
    """Sync Wealthfront accounts and balances via internal API."""
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")

    try:
        cookies = _load_cookies(profile)
        log.info("Loaded %d cookies for Wealthfront (login: %s)", len(cookies), profile)

        data = _api_get(cookies, OVERVIEWS_URL)
        overviews = data.get("overviews", [])
        log.info("Got %d account(s) from Wealthfront API", len(overviews))

        # Store the raw API response
        raw_key = f"wealthfront/{timestamp}_overviews.json"
        raw_payload = json.dumps(data, indent=2).encode()
        store.put(raw_key, raw_payload)

        # Store external accounts (linked accounts from other institutions)
        try:
            external = _api_get(cookies, "/api/external_accounts")
            store.put(
                f"wealthfront/{timestamp}_external_accounts.json",
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
            acct_type_str = overview.get("accountType", "")
            display_name = overview.get("accountDisplayName", f"Account {acct_id}")
            state = overview.get("state", "")
            value_summary = overview.get("accountValueSummary", {})
            total_value = value_summary.get("totalValue")

            if not acct_id:
                log.warning("Skipping account with no ID: %s", overview)
                continue

            if state not in ("FUNDED", "OPENED"):
                log.info("Skipping %s account: %s [%s]", state, display_name, acct_id)
                continue

            account_type = _resolve_account_type(acct_type_str)

            # Store per-account manifest
            manifest = {
                "institution": "wealthfront",
                "account_name": display_name,
                "account_type": account_type.value,
                "external_id": acct_id,
                "wf_account_type": acct_type_str,
                "balance": total_value,
                "state": state,
                "synced_at": timestamp,
            }
            manifest_key = f"wealthfront/{timestamp}_{acct_id}.json"
            store.put(manifest_key, json.dumps(manifest, indent=2).encode())

            account = db.get_or_create_account(
                name=display_name,
                account_type=account_type,
                institution="wealthfront",
                external_id=acct_id,
                profile=profile,
            )
            log.info("Synced: %s [%s] %s", display_name, acct_id, account_type.value)

            if total_value is not None:
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=date.today(),
                        balance=float(total_value),
                        source="wealthfront_api",
                        raw_file_ref=raw_key,
                    )
                )
                log.info("  Balance: $%s", f"{total_value:,.2f}")

            # Download supplementary data
            _download_supplementary(cookies, store, acct_id, numeric_ids, timestamp)

            # Ingest performance history (balance + invested + earned)
            perf_key = f"wealthfront/{timestamp}_{acct_id}_performance.json"
            if store.exists(perf_key):
                perf_data = json.loads(store.get(perf_key))
                history = perf_data.get("historyList", [])
                perf_rows: list[tuple[str, str, float, float | None, float | None]] = []
                for entry in history:
                    mv = entry.get("marketValue")
                    if mv is not None:
                        invested = entry.get("sumNetDeposits")
                        earned = (mv - invested) if invested is not None else None
                        perf_rows.append((
                            account.id,
                            entry["date"],
                            float(mv),
                            float(invested) if invested is not None else None,
                            float(earned) if earned is not None else None,
                        ))
                db.insert_performance_batch(perf_rows)
                log.info("  Performance history: %d points", len(perf_rows))

            # Ingest transfers as transactions
            transfers_key = f"wealthfront/{timestamp}_{acct_id}_transfers.json"
            if store.exists(transfers_key):
                transfers_data = json.loads(store.get(transfers_key))
                txn_count = ingest_transfers(
                    db, account.id, transfers_data, transfers_key
                )
                log.info("  Ingested %d transactions from transfers", txn_count)

            # Ingest holdings from open lots (aggregate by symbol)
            open_lots_key = f"wealthfront/{timestamp}_{acct_id}_open_lots.json"
            if store.exists(open_lots_key):
                lots_raw: Any = json.loads(store.get(open_lots_key))
                lots_list: list[dict[str, Any]] = lots_raw.get(
                    "openLotForDisplayList", []
                )
                # Aggregate multiple lots per symbol
                by_symbol: dict[str, dict[str, float]] = {}
                for lot in lots_list:
                    sym = lot.get("symbol", "")
                    if not sym:
                        continue
                    if sym not in by_symbol:
                        by_symbol[sym] = {"shares": 0.0, "value": 0.0, "cost_basis": 0.0}
                    by_symbol[sym]["shares"] += float(lot.get("quantity", 0))
                    by_symbol[sym]["value"] += float(lot.get("currentValue", 0))
                    by_symbol[sym]["cost_basis"] += float(lot.get("costBasis", 0))

                holding_rows: list[Holding] = []
                for sym, agg in by_symbol.items():
                    if agg["shares"] > 0:
                        holding_rows.append(Holding(
                            account_id=account.id,
                            as_of=date.today(),
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
