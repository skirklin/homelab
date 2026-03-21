"""Capital One ingester — uses cookie relay + internal REST API."""

import json
import logging
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import quote

from money.config import cookie_relay_path
from money.db import Database
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


def _load_cookies(profile: str | None = None) -> dict[str, str]:
    """Load relayed cookies from the Chrome extension."""
    path = (
        cookie_relay_path("capital_one", profile) if profile else cookie_relay_path("capital_one")
    )
    if not path.exists() and profile:
        path = cookie_relay_path("capital_one")
    if not path.exists():
        raise FileNotFoundError(
            "No cookies found for capital_one. Log into Capital One in Chrome and "
            "click the Cookies button in the extension."
        )

    data = json.loads(path.read_text())
    cookies: dict[str, str] = {}
    for c in data.get("cookies", []):
        domain: str = c.get("domain", "")
        # Include cookies from myaccounts and the broader .capitalone.com domain
        if "capitalone" not in domain:
            continue
        cookies[c["name"]] = c["value"]

    if "JSESSIONID" not in cookies:
        raise ValueError("Cookie file missing JSESSIONID — recapture from extension.")
    log.info("Relevant cookies: %s", ", ".join(cookies.keys()))
    return cookies


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


def sync_capital_one(
    db: Database,
    store: RawStore,
    profile: str | None = None,
) -> None:
    """Sync Capital One credit card accounts, balances, and transactions."""
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")

    raw_key = f"capital_one/{timestamp}_accounts.json"

    try:
        cookies = _load_cookies(profile)
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
            cycle_info: dict[str, Any] = card_acct.get("cycleInfo", {})

            display_name = name_info.get("displayName", name_info.get("name", "Unknown"))
            last_four = card_acct.get("plasticIdLastFour", ref_id[:8])

            account = db.get_or_create_account(
                name=display_name,
                account_type=AccountType.CREDIT_CARD,
                institution="capital_one",
                external_id=str(last_four),
                profile=profile,
            )
            log.info("Account: %s (id=%s)", display_name, account.id)

            # 2. Record balance (credit card balance is a liability — store as negative)
            current_balance = cycle_info.get("currentBalance")
            if current_balance is not None:
                balance_val = -float(current_balance)
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=date.today(),
                        balance=balance_val,
                        source="capital_one_api",
                        raw_file_ref=raw_key,
                    )
                )
                log.info("  Balance: $%.2f (owed: $%.2f)", balance_val, current_balance)

            # 3. Fetch transactions — only go back to last known transaction
            encoded_ref = _encode_ref(ref_id)
            chunk_end = date.today()
            total_txn_count = 0
            chunk_num = 0

            # Check how far back we need to go
            last_txn_row = db.conn.execute(
                "SELECT MAX(date) FROM transactions WHERE account_id = ?",
                (account.id,),
            ).fetchone()
            if last_txn_row and last_txn_row[0]:
                # Overlap by 7 days to catch any late-posting transactions
                earliest = date.fromisoformat(last_txn_row[0]) - timedelta(days=7)
                log.info("  Incremental sync from %s", earliest)
            else:
                earliest = date(chunk_end.year - 2, chunk_end.month, chunk_end.day)
                log.info("  Full backfill to %s", earliest)

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
                        f"capital_one/{timestamp}_{last_four}"
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

                    chunk_count = 0
                    for entry in raw_entries:
                        txn_date_str: str | None = entry.get(
                            "transactionDate", entry.get("transactionDisplayDate"),
                        )
                        if not txn_date_str:
                            continue

                        txn_date = date.fromisoformat(txn_date_str[:10])
                        amount = float(entry.get("transactionAmount", 0.0))
                        debit_credit = str(entry.get("transactionDebitCredit", ""))
                        amount = -abs(amount) if debit_credit == "Debit" else abs(amount)

                        description: str = entry.get("transactionDescription", "")
                        category: str | None = entry.get("displayCategory")

                        db.insert_transaction(
                            Transaction(
                                account_id=account.id,
                                date=txn_date,
                                amount=amount,
                                description=description,
                                category=category,
                                raw_file_ref=txn_key,
                            )
                        )
                        chunk_count += 1

                    total_txn_count += chunk_count
                    if chunk_count > 0:
                        log.info("  %s to %s: %d transactions",
                                 chunk_start, chunk_end, chunk_count)

                    # If we got zero results, no point going further back
                    if chunk_count == 0 and chunk_num > 0:
                        break

                    chunk_end = chunk_start - timedelta(days=1)
                    chunk_num += 1

                log.info("  Stored %d total transaction(s)", total_txn_count)

            except Exception as e:
                log.warning("  Could not fetch transactions for %s: %s", display_name, e)
                if total_txn_count > 0:
                    log.info("  (got %d transactions before error)", total_txn_count)

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
