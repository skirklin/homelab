"""Ally Bank ingester — uses auth token relay + internal API."""

import json
import logging
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from money.config import DATA_DIR
from money.db import Database
from money.ingest.common import ts_to_date
from money.models import AccountType, Balance, IngestionRecord, IngestionStatus, Transaction
from money.storage import RawStore

log = logging.getLogger(__name__)

BASE_URL = "https://secure.ally.com"

ACCOUNT_TYPE_MAP: dict[str, AccountType] = {
    "DDA": AccountType.CHECKING,
    "SAV": AccountType.SAVINGS,
    "MMA": AccountType.SAVINGS,
    "CD": AccountType.SAVINGS,
    "IRA": AccountType.IRA,
}


def _api_request(
    token: str,
    path: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    cookies: dict[str, str] | None = None,
) -> Any:
    """Make an authenticated request to Ally's internal API."""
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, method=method)

    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ))

    if cookies:
        req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))

    data = None
    if body is not None:
        data = json.dumps(body).encode()

    resp = urllib.request.urlopen(req, data)
    return json.loads(resp.read())


def _resolve_account_type(ally_type: str) -> AccountType:
    """Map Ally account type string to our AccountType."""
    return ACCOUNT_TYPE_MAP.get(ally_type, AccountType.CHECKING)


def _fetch_all_transactions(
    token: str,
    account_id: str,
    cookies: dict[str, str] | None = None,
    cutoff_date: str | None = None,
) -> list[dict[str, Any]]:
    """Fetch posted transactions for an account, handling pagination.

    If cutoff_date is provided (YYYY-MM-DD), stops paginating once it reaches
    transactions older than that date.
    """
    all_transactions: list[dict[str, Any]] = []

    request_body: dict[str, Any] = {
        "accountNumberPvtEncrypt": account_id,
        "recordsToPull": 100,
    }

    page = 1
    while True:
        log.info("  Fetching transactions page %d...", page)
        data = _api_request(
            token,
            "/acs/v1/bank-accounts/transactions/search",
            method="POST",
            body=request_body,
            cookies=cookies,
        )

        for result in data.get("searchResults", []):
            for history in result.get("transactionHistory", []):
                if history.get("transactionStatusType") != "POSTED":
                    continue

                txns = history.get("transactions", [])
                all_transactions.extend(txns)

                # Stop if we've reached transactions we already have
                if cutoff_date and txns:
                    oldest = txns[-1].get("transactionPostingDate", "")[:10]
                    if oldest < cutoff_date:
                        log.info("  Reached cutoff date %s at page %d", cutoff_date, page)
                        return all_transactions

                # Check for next page
                next_page = history.get("nextPageRequestDetails")
                if next_page and txns:
                    request_body = next_page
                    request_body["recordsToPull"] = 100
                    page += 1
                else:
                    return all_transactions

    return all_transactions


def parse_raw_ally(
    db: Database,
    inst_dir: Path,
    timestamp: str,
    profile: str,
) -> dict[str, int]:
    """Parse raw Ally API captures for a given timestamp and write to DB.

    Reads:
      {inst_dir}/{timestamp}_accounts.json
      {inst_dir}/{timestamp}_{external_id}_transactions.json  (per account)

    Returns a summary dict with counts of accounts/balances/transactions written.
    """
    as_of = ts_to_date(timestamp)

    from money.ingest.schemas import AllyAccount

    accounts_data = json.loads((inst_dir / f"{timestamp}_accounts.json").read_text())

    # transfer-accounts format uses "accounts" key, old format uses "data"
    raw_list = accounts_data.get("accounts") or accounts_data.get("data") or []
    accounts: list[AllyAccount] = list(raw_list)
    raw_key = f"ally/{profile}/{timestamp}_accounts.json"

    seen_transactions: set[tuple[str, float, str]] = set()
    account_count = 0
    txn_count_total = 0
    for acct in accounts:
        details = acct.get("domainDetails", {})

        # Skip external/linked accounts (e.g. Bank of America)
        if details.get("externalAccountIndicator"):
            continue

        acct_number = (
            acct.get("accountNumberPvtEncrypt")
            or acct.get("accountNumber", "")
        )
        acct_name = (
            acct.get("nickname")
            or details.get("accountNickname")
            or acct.get("nickName")
            or acct.get("name", f"Account {str(acct_number)[-4:]}")
        )
        acct_type_str = acct.get("accountType") or acct.get("type", "DDA")
        status = acct.get("accountStatus") or acct.get("status", "")
        current_balance = (
            acct.get("currentBalance")
            or acct.get("balance", {}).get("current")
        )

        if status.upper() != "ACTIVE":
            log.info("Skipping %s account: %s", status, acct_name)
            continue

        external_id = str(acct_number)[-4:] if acct_number else ""
        account_type = ACCOUNT_TYPE_MAP.get(acct_type_str, AccountType.CHECKING)

        account = db.get_or_create_account(
            name=acct_name,
            account_type=account_type,
            institution="ally",
            external_id=external_id,
            profile=profile,
        )
        account_count += 1
        log.info("Ally: %s ••%s [%s]", acct_name, external_id, account_type.value)

        if current_balance is not None:
            db.insert_balance(
                Balance(
                    account_id=account.id,
                    as_of=as_of,
                    balance=float(current_balance),
                    source="ally_api",
                    raw_file_ref=raw_key,
                )
            )

        # Transactions
        txn_path = inst_dir / f"{timestamp}_{external_id}_transactions.json"
        if not txn_path.exists():
            continue
        txns_raw = json.loads(txn_path.read_text())
        if not isinstance(txns_raw, list):
            continue

        txn_key = f"ally/{profile}/{timestamp}_{external_id}_transactions.json"
        txn_count = 0
        for txn in txns_raw:
            txn_date_str = txn["transactionPostingDate"]
            txn_amount = txn["transactionAmountPvtEncrypt"]
            txn_desc = txn["transactionDescription"]

            if txn_amount is None or not txn_date_str:
                continue

            fingerprint = (txn_date_str[:10], float(txn_amount), txn_desc)
            if fingerprint in seen_transactions:
                continue
            seen_transactions.add(fingerprint)

            db.insert_transaction(
                Transaction(
                    account_id=account.id,
                    date=date.fromisoformat(txn_date_str[:10]),
                    amount=float(txn_amount),
                    description=txn_desc,
                    category=txn.get("transactionType"),
                    raw_file_ref=txn_key,
                )
            )
            txn_count += 1

        txn_count_total += txn_count
        if txn_count:
            log.info("  Ally %s: %d transactions", external_id, txn_count)

    return {"accounts": account_count, "transactions": txn_count_total}


def parse_raw_ally_extension(
    db: Database,
    inst_dir: Path,
    profile: str,
) -> int:
    """Parse any extension capture files (extension_*.json) in inst_dir.

    These are separate from the timestamped API captures and should only
    be processed once per replay, not once per timestamp.

    Returns the number of balance records inserted.
    """
    ext_files = sorted(inst_dir.glob("extension_*.json"))
    balance_count = 0
    for ext_path in ext_files:
        data = json.loads(ext_path.read_text())
        if not data:
            continue
        ext_accounts: list[dict[str, Any]] = data.get("accounts", [])
        scraped_at = data.get("scraped_at", "")
        ext_as_of = (
            date.fromisoformat(scraped_at[:10]) if scraped_at else date.today()
        )

        for ext_acct in ext_accounts:
            name = ext_acct.get("name", "")
            ext_id = ext_acct.get("external_id", "")
            raw_type = ext_acct.get("account_type", "checking")

            if not name or not ext_id:
                continue

            type_map = {"checking": AccountType.CHECKING, "savings": AccountType.SAVINGS}
            ext_account = db.get_or_create_account(
                name=name,
                account_type=type_map.get(raw_type, AccountType.CHECKING),
                institution="ally",
                external_id=ext_id,
                profile=profile,
            )

            bal = ext_acct.get("balance")
            if bal is not None:
                db.insert_balance(
                    Balance(
                        account_id=ext_account.id,
                        as_of=ext_as_of,
                        balance=float(bal),
                        source="ally_extension",
                        raw_file_ref=f"ally/{profile}/{ext_path.name}",
                    )
                )
                balance_count += 1

    return balance_count


def sync_ally_api(db: Database, store: RawStore, profile: str,
                  cookies: dict[str, str]) -> None:
    """Sync Ally Bank accounts and transactions via internal API.

    Requires cookies from a Playwright login session (including Ally-CIAM-Token).
    """
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")

    try:
        token = cookies["Ally-CIAM-Token"]
        log.info("Loaded auth token and %d cookies for Ally", len(cookies))

        # Fetch customer info and accounts
        customer = _api_request(token, "/acs/v3/customers/self", cookies=cookies)
        customer_data = customer.get("data", {})

        # Store customer response for debugging
        store.put(
            f"ally/{profile}/{timestamp}_customer.json",
            json.dumps(customer, indent=2).encode(),
        )

        customer_id = None
        for rel in customer_data.get("lobRelationships", []):
            if rel.get("lob") == "ACM":
                customer_id = rel["id"]
                break

        if not customer_id:
            # Fall back to top-level customer ID
            customer_id = customer_data.get("id")

        if not customer_id:
            raise ValueError("Could not determine customer ID from /acs/v3/customers/self")

        log.info("Customer: %s %s (ID: %s)",
                 customer_data.get("name", {}).get("first", ""),
                 customer_data.get("name", {}).get("last", ""),
                 customer_id)

        # Fetch all accounts — try multiple endpoint patterns
        accounts_data = None
        for accounts_path in [
            f"/acs/v1/customer-transfers/transfer-accounts?customerId={customer_id}",
            f"/acs/v3/customers/{customer_id}/accounts",
            f"/acs/v2/customers/{customer_id}/accounts",
        ]:
            try:
                accounts_data = _api_request(token, accounts_path, cookies=cookies)
                log.info("Accounts fetched via %s", accounts_path)
                break
            except Exception as e:
                log.debug("Accounts endpoint %s failed: %s", accounts_path, e)
                continue

        if accounts_data is None:
            raise ValueError("Could not fetch accounts from any known endpoint")

        # Store raw accounts response
        store.put(
            f"ally/{profile}/{timestamp}_accounts.json",
            json.dumps(accounts_data, indent=2).encode(),
        )

        # transfer-accounts returns {"accounts": [...]}, others return {"data": [...]}
        accounts: list[dict[str, Any]] = list(
            accounts_data.get("accounts") or accounts_data.get("data") or []
        )
        log.info("Got %d account(s) from Ally API", len(accounts))

        for acct in accounts:
            details = acct.get("domainDetails", {})

            # Skip external/linked accounts (e.g. Bank of America)
            if details.get("externalAccountIndicator"):
                continue

            acct_id = (
                details.get("accountId")
                or acct.get("id", "")
            )
            acct_number = (
                acct.get("accountNumberPvtEncrypt")
                or acct.get("accountNumber", "")
            )
            external_id = acct_number[-4:] if acct_number else str(acct_id)[:8]
            status = acct.get("accountStatus") or acct.get("status", "")

            if status.upper() != "ACTIVE":
                continue

            # Compute cutoff: 14 days before the most recent transaction we have
            existing = db.get_account_by_external_id("ally", external_id)
            cutoff_date: str | None = None
            if existing:
                last_row = db.conn.execute(
                    "SELECT MAX(date) FROM transactions WHERE account_id = ?",
                    (existing.id,),
                ).fetchone()
                if last_row and last_row[0]:
                    cutoff = date.fromisoformat(last_row[0]) - timedelta(days=14)
                    cutoff_date = cutoff.isoformat()
                    log.info("  Incremental sync from %s", cutoff_date)

            try:
                txns_raw = _fetch_all_transactions(token, acct_id, cookies, cutoff_date)
                log.info("  Fetched %d transactions", len(txns_raw))

                # Store raw transactions
                txn_key = f"ally/{profile}/{timestamp}_{external_id}_transactions.json"
                store.put(txn_key, json.dumps(txns_raw, indent=2).encode())

            except Exception as e:
                acct_name = (
                    acct.get("nickname")
                    or details.get("accountNickname")
                    or acct.get("nickName")
                    or acct.get("name", f"Account {external_id}")
                )
                log.warning("  Could not fetch transactions for %s: %s", acct_name, e)

            # Fetch monthly trends
            try:
                charts = _api_request(
                    token,
                    f"/acs/v1/bank-accounts/charts/{acct_id}",
                    cookies=cookies,
                )
                store.put(
                    f"ally/{profile}/{timestamp}_{external_id}_charts.json",
                    json.dumps(charts, indent=2).encode(),
                )
                trends = charts.get("monthlyTrends", [])
                log.info("  Stored %d months of income/expense trends", len(trends))
            except Exception as e:
                log.warning("  Could not fetch charts for %s: %s", acct_id, e)

            # Fetch account details
            try:
                acct_details = _api_request(
                    token,
                    f"/acs/v1/bank-accounts/{acct_id}",
                    cookies=cookies,
                )
                store.put(
                    f"ally/{profile}/{timestamp}_{external_id}_details.json",
                    json.dumps(acct_details, indent=2).encode(),
                )
                log.info("  Stored account details")
            except Exception as e:
                log.warning("  Could not fetch details for %s: %s", acct_id, e)

        # Parse all raw data and write to DB
        from money.config import DATA_DIR as _DATA_DIR
        inst_dir = _DATA_DIR / "raw" / "ally" / profile
        parse_raw_ally(db, inst_dir, timestamp, profile)

        db.insert_ingestion_record(
            IngestionRecord(
                source="ally_api",
                profile=profile,
                status=IngestionStatus.SUCCESS,
                raw_file_ref=f"ally/{profile}/{timestamp}_accounts.json",
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )

    except Exception as e:
        log.error("Ally API sync failed: %s", e)
        db.insert_ingestion_record(
            IngestionRecord(
                source="ally_api",
                profile=profile,
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise


def sync_ally(db: Database, store: RawStore, profile: str) -> None:
    """Sync Ally Bank from captured network log data.

    The extension captures API responses made by the SPA (including injected
    transaction fetches). This function extracts accounts and transactions
    from those captured responses.
    """
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")

    try:
        log_dir = DATA_DIR / "network_logs"
        logs = sorted(log_dir.glob("ally_*.json")) if log_dir.exists() else []
        if not logs:
            raise FileNotFoundError(
                "No Ally network logs found. Visit Ally in Chrome to capture data."
            )

        entries: list[dict[str, Any]] = []
        for log_file in logs:
            file_data: dict[str, Any] = json.loads(log_file.read_text())
            entries.extend(file_data.get("entries", []))
        log.info("Loaded %d entries from %d network log files", len(entries), len(logs))

        accounts_data: dict[str, Any] | None = None
        all_transactions: list[dict[str, Any]] = []

        for entry in entries:
            url: str = entry.get("url", "")
            body = entry.get("responseBody")
            if not isinstance(body, dict):
                continue

            if "transfer-accounts" in url or ("/customers/" in url and "/accounts" in url):
                if body.get("accounts") or body.get("data"):
                    accounts_data = body
                    log.info("Found accounts response from %s", url)
            elif "transactions/search" in url:
                for result in body.get("searchResults", []):
                    for history in result.get("transactionHistory", []):
                        txns = history.get("transactions", [])
                        all_transactions.extend(txns)

        if accounts_data is None:
            raise ValueError("No accounts response found in network log")

        store.put(
            f"ally/{profile}/{timestamp}_accounts.json",
            json.dumps(accounts_data, indent=2).encode(),
        )

        raw_accounts: list[dict[str, Any]] = list(
            accounts_data.get("accounts") or accounts_data.get("data") or []
        )
        log.info("Found %d account(s) and %d transactions in network log",
                 len(raw_accounts), len(all_transactions))

        for acct in raw_accounts:
            details = acct.get("domainDetails", {})
            if details.get("externalAccountIndicator"):
                continue
            acct_number = acct.get("accountNumberPvtEncrypt", "")
            external_id = acct_number[-4:] if acct_number else ""
            if external_id and all_transactions:
                store.put(
                    f"ally/{profile}/{timestamp}_{external_id}_transactions.json",
                    json.dumps(all_transactions, indent=2).encode(),
                )

        inst_dir = DATA_DIR / "raw" / "ally" / profile
        parse_raw_ally(db, inst_dir, timestamp, profile)

        db.insert_ingestion_record(
            IngestionRecord(
                source="ally",
                profile=profile,
                status=IngestionStatus.SUCCESS,
                raw_file_ref=f"ally/{profile}/{timestamp}_accounts.json",
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )

        for log_file in logs:
            log_file.unlink()
        log.info("Ally sync complete (cleaned up %d network log files)", len(logs))

    except Exception as e:
        log.error("Ally sync failed: %s", e)
        db.insert_ingestion_record(
            IngestionRecord(
                source="ally",
                profile=profile,
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise


from money.ingest.registry import InstitutionInfo

INSTITUTION = InstitutionInfo(
    name="ally",
    dir_name="ally",
    sync_fn=sync_ally,
    parse_fn=parse_raw_ally,
    anchor_file="accounts.json",
    display_name="Ally Bank",
    post_replay_fn=parse_raw_ally_extension,
)
