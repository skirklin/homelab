"""Capital One ingester — uses cookie relay + internal REST API."""

import json
import logging
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote

from money.db import Database
from money.ingest.common import ts_to_date
from money.models import AccountType, Balance, IngestionRecord, IngestionStatus, Transaction
from money.storage import RawStore

log = logging.getLogger(__name__)

BASE_URL = "https://myaccounts.capitalone.com"
ACCOUNTS_PATH = "/web-api/protected/1350813/credit-cards/card-customers/accounts"
TRANSACTIONS_PATH = "/web-api/protected/19902/credit-cards/accounts/{ref}/transactions"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/145.0.0.0 Safari/537.36"
)



def _api_get(cookies: dict[str, str], path: str) -> Any:
    """Make an authenticated GET to Capital One's internal API."""
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url)
    req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))
    req.add_header("Accept", "application/json;v=1")
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Referer", "https://myaccounts.capitalone.com/accountSummary")
    req.add_header("X-UI-Routing-Id", "accountSummary")
    req.add_header("Accept-Language", "en-US")

    try:
        resp = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        log.error("HTTP %d on %s: %s", e.code, path, body)
        raise
    body = resp.read()
    if not body:
        raise ValueError(f"Empty response from {path} (status {resp.status})")
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        preview = body.decode("utf-8", errors="replace")[:200]
        raise ValueError(f"Non-JSON response from {path}: {preview}") from None


def _encode_ref(ref_id: str) -> str:
    """URL-encode an account reference ID for use in API paths.

    Capital One's frontend double-encodes the reference ID in transaction URLs.
    """
    return quote(quote(ref_id, safe=""), safe="")


def parse_raw_capital_one(
    db: Database,
    inst_dir: Path,
    timestamp: str,
    profile: str | None,
) -> dict[str, int]:
    """Parse raw Capital One API captures for a given timestamp and write to DB.

    Reads:
      {inst_dir}/{timestamp}_accounts.json
      {inst_dir}/{timestamp}_{last_four}_transactions_{chunk}.json  (chunked)

    Returns a summary dict with counts written.
    """
    as_of = ts_to_date(timestamp)

    from money.ingest.schemas import COAccountsResponse

    accounts_response = COAccountsResponse.model_validate_json(
        (inst_dir / f"{timestamp}_accounts.json").read_text()
    )
    raw_accounts = accounts_response.accounts
    raw_key = f"capital_one/{profile}/{timestamp}_accounts.json"
    account_count = 0
    txn_count_total = 0

    for raw_acct in raw_accounts:
        card_acct = raw_acct.cardAccount
        name_info = card_acct.nameInfo
        cycle_info = card_acct.cycleInfo

        display_name = name_info.displayName
        last_four = card_acct.plasticIdLastFour

        account = db.get_or_create_account(
            name=display_name,
            account_type=AccountType.CREDIT_CARD,
            institution="capital_one",
            external_id=str(last_four),
            profile=profile,
        )
        account_count += 1
        log.info("Capital One: %s (id=%s)", display_name, account.id)

        current_balance = cycle_info.currentBalance
        db.insert_balance(
            Balance(
                account_id=account.id,
                as_of=as_of,
                balance=-current_balance,
                source="capital_one_api",
                raw_file_ref=raw_key,
            )
        )

        # Transaction files may be a single file or chunked (_0, _1, etc.)
        txn_files = sorted(inst_dir.glob(f"{timestamp}_{last_four}_transactions*.json"))
        if not txn_files:
            continue

        raw_entries: list[dict[str, Any]] = []
        txn_key = f"capital_one/{profile}/{txn_files[0].name}"
        for txn_file in txn_files:
            txn_data = json.loads(txn_file.read_text())
            if not txn_data:
                continue
            if isinstance(txn_data, dict):
                raw_entries.extend(
                    txn_data.get("entries", txn_data.get("transactions", []))
                )
            elif isinstance(txn_data, list):
                raw_entries.extend(txn_data)

        txn_count = 0
        for entry in raw_entries:
            txn_date_str: str | None = entry.get(
                "transactionDate",
                entry.get("transactionDisplayDate"),
            )
            if not txn_date_str:
                continue

            txn_date = date.fromisoformat(txn_date_str[:10])
            amount = float(entry.get("transactionAmount", 0.0))
            debit_credit = str(entry.get("transactionDebitCredit", ""))
            amount = -abs(amount) if debit_credit == "Debit" else abs(amount)

            db.insert_transaction(
                Transaction(
                    account_id=account.id,
                    date=txn_date,
                    amount=amount,
                    description=str(entry.get("transactionDescription", "")),
                    category=entry.get("displayCategory"),
                    raw_file_ref=txn_key,
                )
            )
            txn_count += 1

        txn_count_total += txn_count
        log.info("  Capital One %s: %d transactions", last_four, txn_count)

    log.info("Capital One: parsed snapshot %s (%d accounts)", timestamp, len(raw_accounts))
    return {"accounts": account_count, "transactions": txn_count_total}


def sync_capital_one(
    db: Database,
    store: RawStore,
    profile: str,
    cookies: dict[str, str] | None = None,
    entries: list[dict[str, Any]] | None = None,
) -> None:
    """Sync Capital One credit card accounts, balances, and transactions."""
    if not cookies:
        raise ValueError("Capital One sync requires cookies")
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")

    raw_key = f"capital_one/{profile}/{timestamp}_accounts.json"

    try:
        log.info("Loaded %d cookies for capital_one (login: %s)", len(cookies), profile)

        # 1. Fetch accounts
        accounts_data = _api_get(cookies, ACCOUNTS_PATH)
        store.put(raw_key, json.dumps(accounts_data, indent=2).encode())

        raw_accounts: list[dict[str, Any]] = accounts_data.get("accounts", [])
        log.info("Found %d Capital One account(s)", len(raw_accounts))

        for raw_acct in raw_accounts:
            card_acct: dict[str, Any] = raw_acct.get("cardAccount", {})
            ref_id: str = raw_acct.get("accountReferenceId", "")
            name_info: dict[str, Any] = card_acct.get("nameInfo", {})

            display_name = name_info.get("displayName", name_info.get("name", "Unknown"))
            last_four = card_acct.get("plasticIdLastFour", ref_id[:8])

            # 2. Fetch transactions — only go back to last known transaction
            encoded_ref = _encode_ref(ref_id)
            chunk_end = date.today()
            chunk_num = 0

            # Check how far back we need to go (using placeholder account lookup)
            # We need the account ID before creating/getting it to check for existing txns.
            # Use a DB query by institution + external_id.
            existing = db.get_account_by_external_id("capital_one", str(last_four))
            if existing:
                last_txn_row = db.conn.execute(
                    "SELECT MAX(date) FROM transactions WHERE account_id = ?",
                    (existing.id,),
                ).fetchone()
                if last_txn_row and last_txn_row[0]:
                    earliest = date.fromisoformat(last_txn_row[0]) - timedelta(days=7)
                    log.info("  Incremental sync from %s", earliest)
                else:
                    earliest = chunk_end - timedelta(days=730)
                    log.info("  Full backfill to %s", earliest)
            else:
                earliest = chunk_end - timedelta(days=730)
                log.info("  Full backfill to %s (new account: %s)", earliest, display_name)

            try:
                while chunk_end > earliest:
                    chunk_start = chunk_end - timedelta(days=90)
                    if chunk_start < earliest:
                        chunk_start = earliest

                    txn_path = (
                        TRANSACTIONS_PATH.format(ref=encoded_ref)
                        + f"?fromDate={chunk_start.isoformat()}"
                        + f"&toDate={chunk_end.isoformat()}"
                        + "&include=viewOrderMetadata"
                    )

                    txn_data = _api_get(cookies, txn_path)
                    txn_key = (
                        f"capital_one/{profile}/{timestamp}_{last_four}"
                        f"_transactions_{chunk_num}.json"
                    )
                    store.put(txn_key, json.dumps(txn_data, indent=2).encode())

                    raw_entries: list[dict[str, Any]]
                    if isinstance(txn_data, dict):
                        raw_entries = list(
                            txn_data.get("entries", txn_data.get("transactions", []))
                        )
                    elif isinstance(txn_data, list):
                        raw_entries = list(txn_data)
                    else:
                        raw_entries = []

                    chunk_count = len(raw_entries)
                    if chunk_count > 0:
                        log.info("  %s to %s: %d transactions",
                                 chunk_start, chunk_end, chunk_count)

                    # If we got zero results, no point going further back
                    if chunk_count == 0 and chunk_num > 0:
                        break

                    chunk_end = chunk_start - timedelta(days=1)
                    chunk_num += 1

            except Exception as e:
                log.warning("  Could not fetch transactions for %s: %s", display_name, e)

        # Parse all raw data and write to DB
        from money.config import DATA_DIR as _DATA_DIR
        inst_dir = _DATA_DIR / "raw" / "capital_one" / (profile or "default")
        parse_raw_capital_one(db, inst_dir, timestamp, profile)

        db.insert_ingestion_record(
            IngestionRecord(
                source="capital_one",
                profile=profile,
                status=IngestionStatus.SUCCESS,
                raw_file_ref=raw_key,
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        log.info("Capital One sync complete.")

    except Exception as e:
        log.error("Capital One sync failed: %s", e)
        db.insert_ingestion_record(
            IngestionRecord(
                source="capital_one",
                profile=profile,
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise


from money.ingest.registry import InstitutionInfo  # noqa: E402


def _extract_identity(
    cookies: list[dict[str, Any]], entries: list[dict[str, Any]],
) -> str | None:
    """Extract username from Capital One SIC_RM_VAL cookie (url-encoded: 'user|hash')."""
    from urllib.parse import unquote
    for cookie in cookies:
        if cookie.get("name") == "SIC_RM_VAL":
            val = unquote(cookie.get("value", ""))
            if "|" in val:
                return val.split("|", 1)[0]
    return None


INSTITUTION = InstitutionInfo(
    name="capital_one",
    dir_name="capital_one",
    sync_fn=sync_capital_one,
    parse_fn=parse_raw_capital_one,
    anchor_file="accounts.json",
    display_name="Capital One",
    extract_identity=_extract_identity,
)