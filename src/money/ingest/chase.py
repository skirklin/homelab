"""Chase ingester — parses captured network log data."""

import json
import logging
from datetime import date, datetime
from pathlib import Path

from money.config import DATA_DIR
from money.db import Database
from money.ingest.common import ts_to_date
from money.ingest.schemas import (
    CHActivityOptionsResponse,
    CHCardReward,
    CHCardRewardsResponse,
    CHDashboardCacheEntry,
    CHDashboardResponse,
    CHDdaDetailResponse,
    CHNetworkLog,
    CHNetworkLogEntry,
    CHTransaction,
    CHTransactionsResponse,
)
from money.models import AccountType, Balance, IngestionRecord, IngestionStatus, Transaction
from money.storage import RawStore

log = logging.getLogger(__name__)

# Union of all possible response body types keyed in the parsed results dict.
_CHResponseBody = (
    CHDdaDetailResponse | CHTransactionsResponse | CHCardRewardsResponse | CHDashboardResponse
)


def _load_network_log() -> dict[str, list[_CHResponseBody]]:
    """Load the most recent Chase network log and extract API responses by endpoint.

    Returns a dict mapping endpoint keys to response bodies.
    """
    log_dir = DATA_DIR / "network_logs"
    if not log_dir.exists():
        raise FileNotFoundError("No network logs directory found.")

    logs = sorted(log_dir.glob("chase_*.json"))
    if not logs:
        raise FileNotFoundError(
            "No Chase network logs found. Record a session in Chrome first."
        )

    latest = logs[-1]
    log.info("Using network log: %s", latest.name)
    data: CHNetworkLog = json.loads(latest.read_text())
    return _parse_network_log_entries(data)


def parse_chase_date(date_str: str) -> date:
    """Parse Chase date format (YYYYMMDD) to date."""
    return date(int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]))


def extract_account_list(
    dashboard_responses: list[CHDashboardResponse],
) -> list[CHActivityOptionsResponse]:
    """Extract account list from dashboard module cache."""
    for resp in dashboard_responses:
        cached: list[CHDashboardCacheEntry] = resp.get("cache", [])
        for entry in cached:
            url: str = entry.get("url", "")
            if "activity/options" in url:
                inner = entry.get("response", {})
                if inner.get("accounts"):
                    return [inner]
    return []


def _parse_network_log_entries(
    data: CHNetworkLog,
) -> dict[str, list[_CHResponseBody]]:
    """Parse a raw network log dict into categorised response lists."""
    results: dict[str, list[_CHResponseBody]] = {
        "dda_details": [],
        "transactions": [],
        "card_rewards": [],
        "dashboard": [],
    }
    entries: list[CHNetworkLogEntry] = data.get("entries", [])
    for entry in entries:
        url: str = entry.get("url", "")
        body = entry.get("responseBody")
        if not isinstance(body, dict):
            continue
        if "account/detail/dda/list" in url:
            results["dda_details"].append(body)  # type: ignore[arg-type]
        elif "etu-dda-transactions" in url:
            results["transactions"].append(body)  # type: ignore[arg-type]
        elif "rewards" in url and "summary" in url:
            results["card_rewards"].append(body)  # type: ignore[arg-type]
        elif "dashboard/module" in url:
            results["dashboard"].append(body)  # type: ignore[arg-type]
    return results


def parse_raw_chase(
    db: Database,
    inst_dir: Path,
    timestamp: str,
    profile: str | None,
) -> dict[str, int]:
    """Parse a raw Chase network log for a given timestamp and write to DB.

    Reads:
      {inst_dir}/{timestamp}_network_log.json

    Returns a summary dict with counts written.
    """
    as_of = ts_to_date(timestamp)
    log_file = inst_dir / f"{timestamp}_network_log.json"
    raw_key = f"chase/{timestamp}_network_log.json"

    raw_data: CHNetworkLog = json.loads(log_file.read_text())
    results = _parse_network_log_entries(raw_data)

    # Build account map from dashboard activity/options cache
    dda_account_map: dict[int, CHActivityOptionsResponse] = {}
    for dashboard_resp in results["dashboard"]:
        dr = dashboard_resp  # type: ignore[assignment]
        for cache_entry in dr.get("cache", []):
            if "activity/options" in cache_entry.get("url", ""):
                inner: CHActivityOptionsResponse = cache_entry.get("response", {})
                for acct in inner.get("accounts", []):
                    acct_id = acct.get("id", 0)
                    if acct_id:
                        dda_account_map[acct_id] = acct  # type: ignore[assignment]

    account_count = 0

    # DDA accounts
    seen_dda: set[str] = set()
    for detail_resp in results["dda_details"]:
        dda_resp: CHDdaDetailResponse = detail_resp  # type: ignore[assignment]
        acct_id: int = dda_resp.get("accountId", 0)
        nickname: str = dda_resp.get("nickname", "Unknown")
        mask: str = dda_resp.get("mask", "")

        if mask in seen_dda:
            continue
        seen_dda.add(mask)

        acct_info = dda_account_map.get(acct_id, {})
        acct_type_str: str = acct_info.get("accountType", "CHK")  # type: ignore[attr-defined]
        account_type = AccountType.SAVINGS if acct_type_str == "SAV" else AccountType.CHECKING

        account = db.get_or_create_account(
            name=nickname,
            account_type=account_type,
            institution="chase",
            external_id=mask,
            profile=profile,
        )
        account_count += 1
        log.info("Chase: %s ••%s (id=%s)", nickname, mask, account.id)

        detail: CHDdaDetailResponse = dda_resp.get("detail", {})  # type: ignore[assignment]
        available = float(detail.get("available", 0))  # type: ignore[arg-type]
        db.insert_balance(
            Balance(
                account_id=account.id,
                as_of=as_of,
                balance=available,
                source="chase_network_log",
                raw_file_ref=raw_key,
            )
        )

    # Transactions
    txn_count_total = 0
    for txn_resp_raw in results["transactions"]:
        txn_resp: CHTransactionsResponse = txn_resp_raw  # type: ignore[assignment]
        txn_list: list[CHTransaction] = txn_resp.get("transactions", [])
        if not txn_list:
            continue

        last_balance = float(txn_list[0].get("runningLedgerBalanceAmount", 0))
        matched_account_id: str | None = None

        for dda_raw in results["dda_details"]:
            dda: CHDdaDetailResponse = dda_raw  # type: ignore[assignment]
            detail2: CHDdaDetailResponse = dda.get("detail", {})  # type: ignore[assignment]
            if abs(float(detail2.get("presentBalance", 0)) - last_balance) < 0.01:  # type: ignore[arg-type]
                mask = dda.get("mask", "")
                acct = db.get_account_by_external_id("chase", mask)
                if acct:
                    matched_account_id = acct.id
                    break

        if not matched_account_id:
            log.warning("  Chase: could not match %d transactions to an account", len(txn_list))
            continue

        txn_count = 0
        for txn in txn_list:
            txn_date_str: str = txn.get("transactionPostDate", "")
            if not txn_date_str:
                continue
            db.insert_transaction(
                Transaction(
                    account_id=matched_account_id,
                    date=parse_chase_date(txn_date_str),
                    amount=float(txn.get("transactionAmount", 0)),
                    description=txn.get("transactionDescription", ""),
                    raw_file_ref=raw_key,
                )
            )
            txn_count += 1
        txn_count_total += txn_count
        log.info("  Chase: stored %d transaction(s) for account %s", txn_count, matched_account_id)

    # Credit cards
    for rewards_raw in results["card_rewards"]:
        rewards_resp: CHCardRewardsResponse = rewards_raw  # type: ignore[assignment]
        cards: list[CHCardReward] = rewards_resp.get("cardRewardsSummary", [])
        for card in cards:
            mask = str(card.get("mask", ""))
            card_nickname: str = card.get("nickname", "Unknown")
            card_type: str = card.get("cardType", "")
            db.get_or_create_account(
                name=f"{card_nickname} ({card_type.replace('_', ' ').title()})",
                account_type=AccountType.CREDIT_CARD,
                institution="chase",
                external_id=mask,
                profile=profile,
            )
            account_count += 1

    log.info("Chase: parsed network log %s", timestamp)
    return {"accounts": account_count, "transactions": txn_count_total}


def sync_chase(
    db: Database,
    store: RawStore,
    profile: str | None = None,
) -> None:
    """Sync Chase accounts from captured network log data.

    Chase's API rejects replayed cookies (likely TLS fingerprinting),
    so we parse data directly from the network log captured by the
    Chrome extension.
    """
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")
    raw_key = f"chase/{timestamp}_network_log.json"

    try:
        # Load and store the raw network log
        log_dir = DATA_DIR / "network_logs"
        if not log_dir.exists():
            raise FileNotFoundError("No network logs directory found.")

        logs = sorted(log_dir.glob("chase_*.json"))
        if not logs:
            raise FileNotFoundError(
                "No Chase network logs found. Record a session in Chrome first."
            )

        latest = logs[-1]
        log.info("Using network log: %s", latest.name)
        store.put(raw_key, latest.read_bytes())

        # Parse raw data and write to DB using inst_dir from store location
        from money.config import DATA_DIR as _DATA_DIR

        inst_dir = _DATA_DIR / "raw" / "chase"
        parse_raw_chase(db, inst_dir, timestamp, profile)

        db.insert_ingestion_record(
            IngestionRecord(
                source="chase",
                profile=profile,
                status=IngestionStatus.SUCCESS,
                raw_file_ref=raw_key,
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        log.info("Chase sync complete")

    except Exception as e:
        log.error("Chase sync failed: %s", e)
        db.insert_ingestion_record(
            IngestionRecord(
                source="chase",
                profile=profile,
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise
