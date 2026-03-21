"""Chase ingester — parses captured network log data."""

import json
import logging
from datetime import date, datetime
from pathlib import Path
from typing import Any

from money.config import DATA_DIR
from money.db import Database
from money.models import AccountType, Balance, IngestionRecord, IngestionStatus, Transaction
from money.storage import RawStore

log = logging.getLogger(__name__)


def _load_network_log() -> dict[str, list[dict[str, Any]]]:
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
    data = json.loads(latest.read_text())

    results: dict[str, list[dict[str, Any]]] = {
        "dda_details": [],
        "transactions": [],
        "card_rewards": [],
        "dashboard": [],
    }

    for entry in data.get("entries", []):
        url: str = entry.get("url", "")
        body: dict[str, Any] | None = entry.get("responseBody")
        if not isinstance(body, dict):
            continue

        if "account/detail/dda/list" in url:
            results["dda_details"].append(body)
        elif "etu-dda-transactions" in url:
            results["transactions"].append(body)
        elif "rewards" in url and "summary" in url:
            results["card_rewards"].append(body)
        elif "dashboard/module" in url:
            results["dashboard"].append(body)

    return results


def parse_chase_date(date_str: str) -> date:
    """Parse Chase date format (YYYYMMDD) to date."""
    return date(int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]))


def extract_account_list(
    dashboard_responses: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Extract account list from dashboard module cache."""
    for resp in dashboard_responses:
        cached: list[dict[str, Any]] = resp.get("cache", [])
        for entry in cached:
            url: str = entry.get("url", "")
            if "activity/options" in url:
                inner: dict[str, Any] = entry.get("response", {})
                accounts: list[dict[str, Any]] = inner.get("accounts", [])
                if accounts:
                    return accounts
    return []


def _ts_to_date(ts: str) -> date:
    """Convert a YYYYMMDD_HHMMSS timestamp to a date."""
    return date(int(ts[:4]), int(ts[4:6]), int(ts[6:8]))


def _read_json(path: Path) -> Any:
    """Read and parse a JSON file, or return None if missing."""
    if not path.exists():
        return None
    return json.loads(path.read_text())


def _parse_network_log_entries(data: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Parse a raw network log dict into categorised response lists."""
    results: dict[str, list[dict[str, Any]]] = {
        "dda_details": [],
        "transactions": [],
        "card_rewards": [],
        "dashboard": [],
    }
    for entry in data.get("entries", []):
        url: str = entry.get("url", "")
        body = entry.get("responseBody")
        if not isinstance(body, dict):
            continue
        if "account/detail/dda/list" in url:
            results["dda_details"].append(body)
        elif "etu-dda-transactions" in url:
            results["transactions"].append(body)
        elif "rewards" in url and "summary" in url:
            results["card_rewards"].append(body)
        elif "dashboard/module" in url:
            results["dashboard"].append(body)
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
    as_of = _ts_to_date(timestamp)
    log_file = inst_dir / f"{timestamp}_network_log.json"
    raw_key = f"chase/{timestamp}_network_log.json"

    data = _read_json(log_file)
    if not data:
        log.warning("Chase: no network log file for %s", timestamp)
        return {}

    results = _parse_network_log_entries(data)

    account_list = extract_account_list(results["dashboard"])
    account_map: dict[int, dict[str, Any]] = {}
    for acct in account_list:
        account_map[acct.get("id", 0)] = acct

    account_count = 0

    # DDA accounts
    seen_dda: set[str] = set()
    for detail_resp in results["dda_details"]:
        acct_id: int = detail_resp.get("accountId", 0)
        nickname: str = detail_resp.get("nickname", "Unknown")
        mask: str = detail_resp.get("mask", "")

        if mask in seen_dda:
            continue
        seen_dda.add(mask)

        acct_info = account_map.get(acct_id, {})
        acct_type_str: str = acct_info.get("accountType", "CHK")
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

        detail: dict[str, Any] = detail_resp.get("detail", {})
        available = float(detail.get("available", 0))
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
    for txn_resp in results["transactions"]:
        txn_list: list[dict[str, Any]] = txn_resp.get("transactions", [])
        if not txn_list:
            continue

        last_balance = float(txn_list[0].get("runningLedgerBalanceAmount", 0))
        matched_account_id: str | None = None

        for detail_resp in results["dda_details"]:
            detail = detail_resp.get("detail", {})
            if abs(float(detail.get("presentBalance", 0)) - last_balance) < 0.01:
                mask = detail_resp.get("mask", "")
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
    for rewards_resp in results["card_rewards"]:
        cards: list[dict[str, Any]] = rewards_resp.get("cardRewardsSummary", [])
        for card in cards:
            mask = str(card.get("mask", ""))
            nickname = card.get("nickname", "Unknown")
            card_type: str = card.get("cardType", "")
            db.get_or_create_account(
                name=f"{nickname} ({card_type.replace('_', ' ').title()})",
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
