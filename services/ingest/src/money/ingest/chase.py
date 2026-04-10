"""Chase ingester — parses captured network log data."""

import logging
from typing import Any
from datetime import date, datetime
from pathlib import Path

from money.config import DATA_DIR
from money.db import Database
from money.ingest.common import ts_to_date
from money.ingest.schemas import (
    CHActivityAccount,
    CHActivityOptionsResponse,
    CHCardRewardsResponse,
    CHDashboardResponse,
    CHDdaDetailResponse,
    CHNetworkLog,
    CHTransactionsResponse,
)
from money.models import AccountType, Balance, IngestionRecord, IngestionStatus, Transaction
from money.storage import RawStore

log = logging.getLogger(__name__)


def _load_network_log() -> tuple[
    list[CHDdaDetailResponse],
    list[CHTransactionsResponse],
    list[CHCardRewardsResponse],
    list[CHDashboardResponse],
]:
    """Load the most recent Chase network log and extract API responses by endpoint.

    Returns four lists: dda_details, transactions, card_rewards, dashboard.
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
    data = CHNetworkLog.model_validate_json(latest.read_text())
    return _parse_network_log_entries(data)


def parse_chase_date(date_str: str) -> date:
    """Parse Chase date format (YYYYMMDD) to date."""
    return date(int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]))


def extract_account_list(
    dashboard_responses: list[CHDashboardResponse],
) -> list[CHActivityOptionsResponse]:
    """Extract account list from dashboard module cache."""
    for resp in dashboard_responses:
        for entry in resp.cache:
            if "activity/options" in entry.url:
                parsed = CHActivityOptionsResponse.model_validate(entry.response)
                if parsed.accounts:
                    return [parsed]
    return []


def _parse_network_log_entries(
    data: CHNetworkLog,
) -> tuple[
    list[CHDdaDetailResponse],
    list[CHTransactionsResponse],
    list[CHCardRewardsResponse],
    list[CHDashboardResponse],
]:
    """Parse a raw network log into categorised response lists."""
    dda_details: list[CHDdaDetailResponse] = []
    transactions: list[CHTransactionsResponse] = []
    card_rewards: list[CHCardRewardsResponse] = []
    dashboard: list[CHDashboardResponse] = []

    for entry in data.entries:
        url = entry.url or ""
        body = entry.responseBody
        if not isinstance(body, dict):
            continue
        if "account/detail/dda/list" in url:
            dda_details.append(CHDdaDetailResponse.model_validate(body))
        elif "etu-dda-transactions" in url:
            transactions.append(CHTransactionsResponse.model_validate(body))
        elif "rewards" in url and "summary" in url:
            card_rewards.append(CHCardRewardsResponse.model_validate(body))
        elif "dashboard/module" in url:
            dashboard.append(CHDashboardResponse.model_validate(body))
    return dda_details, transactions, card_rewards, dashboard


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
    raw_key = f"chase/{profile}/{timestamp}_network_log.json"

    raw_data = CHNetworkLog.model_validate_json(log_file.read_text())
    dda_details, transactions, card_rewards, dashboard = _parse_network_log_entries(raw_data)

    # Build account map from dashboard activity/options cache
    dda_account_map: dict[int, CHActivityAccount] = {}
    for dr in dashboard:
        for cache_entry in dr.cache:
            if "activity/options" in cache_entry.url:
                inner = CHActivityOptionsResponse.model_validate(cache_entry.response)
                for acct in inner.accounts:
                    if acct.id:
                        dda_account_map[acct.id] = acct

    account_count = 0

    # DDA accounts
    seen_dda: set[str] = set()
    for dda_resp in dda_details:
        mask = dda_resp.mask

        if mask in seen_dda:
            continue
        seen_dda.add(mask)

        acct_info = dda_account_map.get(dda_resp.accountId)
        acct_type_str = (acct_info.accountType if acct_info else None) or "CHK"
        account_type = AccountType.SAVINGS if acct_type_str == "SAV" else AccountType.CHECKING

        account = db.get_or_create_account(
            name=dda_resp.nickname,
            account_type=account_type,
            institution="chase",
            external_id=mask,
            profile=profile,
        )
        account_count += 1
        log.info("Chase: %s ••%s (id=%s)", dda_resp.nickname, mask, account.id)

        available = dda_resp.detail.available
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
    for txn_resp in transactions:
        txn_list = txn_resp.transactions
        if not txn_list:
            continue

        last_balance = txn_list[0].runningLedgerBalanceAmount
        matched_account_id: str | None = None

        for dda in dda_details:
            if abs(dda.detail.presentBalance - last_balance) < 0.01:
                acct = db.get_account_by_external_id("chase", dda.mask)
                if acct:
                    matched_account_id = acct.id
                    break

        if not matched_account_id:
            log.warning("  Chase: could not match %d transactions to an account", len(txn_list))
            continue

        txn_count = 0
        for txn in txn_list:
            txn_date_str = txn.transactionPostDate
            if not txn_date_str:
                continue
            db.insert_transaction(
                Transaction(
                    account_id=matched_account_id,
                    date=parse_chase_date(txn_date_str),
                    amount=txn.transactionAmount,
                    description=txn.transactionDescription,
                    raw_file_ref=raw_key,
                )
            )
            txn_count += 1
        txn_count_total += txn_count
        log.info("  Chase: stored %d transaction(s) for account %s", txn_count, matched_account_id)

    # Credit cards
    for rewards_resp in card_rewards:
        for card in rewards_resp.cardRewardsSummary:
            mask = str(card.mask)
            db.get_or_create_account(
                name=f"{card.nickname} ({card.cardType.replace('_', ' ').title()})",
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
    profile: str,
    cookies: dict[str, str] | None = None,
    entries: list[dict[str, Any]] | None = None,
) -> None:
    """Sync Chase accounts from captured network log data.

    Chase's API rejects replayed cookies (likely TLS fingerprinting),
    so we parse data directly from the network log captured by the
    Chrome extension.
    """
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")
    raw_key = f"chase/{profile}/{timestamp}_network_log.json"

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

        inst_dir = _DATA_DIR / "raw" / "chase" / (profile or "default")
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


from money.ingest.registry import InstitutionInfo  # noqa: E402

INSTITUTION = InstitutionInfo(
    name="chase",
    dir_name="chase",
    sync_fn=sync_chase,
    parse_fn=parse_raw_chase,
    anchor_file="network_log.json",
    display_name="Chase",
)
