"""Chase ingester — parses captured network log data."""

import json
import logging
from datetime import date, datetime
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
        responses = _load_network_log()

        # Store raw data
        log_dir = DATA_DIR / "network_logs"
        logs = sorted(log_dir.glob("chase_*.json"))
        store.put(raw_key, logs[-1].read_bytes())

        # 1. Get account list from dashboard
        account_list = extract_account_list(responses["dashboard"])
        log.info("Found %d Chase account(s) in network log", len(account_list))

        # Build lookup of account IDs for matching
        account_map: dict[int, dict[str, Any]] = {}
        for acct in account_list:
            account_map[acct.get("id", 0)] = acct

        # 2. Process DDA (checking/savings) accounts from detail responses
        seen_dda: set[str] = set()
        for detail_resp in responses["dda_details"]:
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
            )
            log.info("Account: %s ••%s (id=%s)", nickname, mask, account.id)

            detail: dict[str, Any] = detail_resp.get("detail", {})
            available: float = float(detail.get("available", 0))
            db.insert_balance(
                Balance(
                    account_id=account.id,
                    as_of=date.today(),
                    balance=available,
                    source="chase_network_log",
                    raw_file_ref=raw_key,
                )
            )
            log.info("  Balance: $%.2f", available)

        # 3. Process transactions from network log
        for txn_resp in responses["transactions"]:
            txn_list: list[dict[str, Any]] = txn_resp.get("transactions", [])
            if not txn_list:
                continue

            # Try to find which account these belong to by checking balances
            last_balance: float = float(txn_list[0].get("runningLedgerBalanceAmount", 0))
            matched_account_id: str | None = None

            for detail_resp in responses["dda_details"]:
                detail = detail_resp.get("detail", {})
                if abs(float(detail.get("presentBalance", 0)) - last_balance) < 0.01:
                    mask = detail_resp.get("mask", "")
                    acct = db.get_account_by_external_id("chase", mask)
                    if acct:
                        matched_account_id = acct.id
                        break

            if not matched_account_id:
                log.warning("  Could not match %d transactions to an account", len(txn_list))
                continue

            txn_count = 0
            for txn in txn_list:
                txn_date_str: str = txn.get("transactionPostDate", "")
                if not txn_date_str:
                    continue
                txn_date = parse_chase_date(txn_date_str)
                amount = float(txn.get("transactionAmount", 0))
                description: str = txn.get("transactionDescription", "")

                db.insert_transaction(
                    Transaction(
                        account_id=matched_account_id,
                        date=txn_date,
                        amount=amount,
                        description=description,
                        raw_file_ref=raw_key,
                    )
                )
                txn_count += 1
            log.info("  Stored %d transaction(s) for account %s", txn_count, matched_account_id)

        # 4. Process credit cards from rewards summary
        for rewards_resp in responses["card_rewards"]:
            cards: list[dict[str, Any]] = rewards_resp.get("cardRewardsSummary", [])
            for card in cards:
                mask = str(card.get("mask", ""))
                nickname = card.get("nickname", "Unknown")
                card_type: str = card.get("cardType", "")

                account = db.get_or_create_account(
                    name=f"{nickname} ({card_type.replace('_', ' ').title()})",
                    account_type=AccountType.CREDIT_CARD,
                    institution="chase",
                    external_id=mask,
                )

                rewards_balance: int = card.get("currentRewardsBalance", 0)
                rewards_type: str = card.get("rewardsType", "POINTS")
                log.info(
                    "Card: %s ••%s — %d %s",
                    nickname, mask, rewards_balance, rewards_type,
                )

        db.insert_ingestion_record(
            IngestionRecord(
                source="chase",
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
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise
