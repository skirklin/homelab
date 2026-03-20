"""Ally Bank ingester — uses auth token relay + internal API."""

import json
import logging
import urllib.request
from datetime import date, datetime
from typing import Any

from money.config import DATA_DIR, cookie_relay_path
from money.db import Database
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


def _load_auth_token(profile: str) -> str:
    """Load the saved auth token for a profile."""
    path = DATA_DIR / "auth_tokens" / f"ally_{profile}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"No auth token at {path}. Run 'money login ally --profile {profile}' first."
        )
    data = json.loads(path.read_text())
    token = data.get("token")
    if not token:
        raise ValueError("Auth token file missing 'token' field.")
    return str(token)


def _load_cookies(profile: str) -> dict[str, str]:
    """Load relayed cookies for a profile."""
    path = cookie_relay_path("ally", profile)
    if not path.exists():
        return {}

    data = json.loads(path.read_text())
    cookies: dict[str, str] = {}
    for c in data.get("cookies", []):
        cookies[c["name"]] = c["value"]
    return cookies


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
) -> list[dict[str, Any]]:
    """Fetch all posted transactions for an account, handling pagination."""
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

                # Check for next page
                next_page = history.get("nextPageRequestDetails")
                if next_page and txns:
                    request_body = next_page
                    request_body["recordsToPull"] = 100
                    page += 1
                else:
                    return all_transactions

    return all_transactions


def sync_ally_api(db: Database, store: RawStore, profile: str,
                  token: str | None = None) -> None:
    """Sync Ally Bank accounts and transactions via internal API.

    If token is provided, uses it directly. Otherwise loads from saved file.
    """
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")

    try:
        if not token:
            token = _load_auth_token(profile)
        cookies = _load_cookies(profile)
        log.info("Loaded auth token and %d cookies for Ally", len(cookies))

        # Fetch customer info and accounts
        customer = _api_request(token, "/acs/v3/customers/self", cookies=cookies)
        customer_data = customer.get("data", {})

        # Store customer response for debugging
        store.put(
            f"ally/{timestamp}_customer.json",
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
        # transfer-accounts returns {"accounts": [...]}, others return {"data": [...]}
        accounts: list[dict[str, Any]] = list(
            accounts_data.get("accounts") or accounts_data.get("data") or []
        )
        log.info("Got %d account(s) from Ally API", len(accounts))

        # Store raw API responses
        raw_key = f"ally/{timestamp}_accounts.json"
        store.put(raw_key, json.dumps(accounts_data, indent=2).encode())

        seen_transactions: set[tuple[str, float, str]] = set()

        for acct in accounts:
            details = acct.get("domainDetails", {})

            # Skip external/linked accounts (e.g. Bank of America)
            if details.get("externalAccountIndicator"):
                continue

            # Support both old API format and transfer-accounts format
            acct_id = (
                details.get("accountId")
                or acct.get("id", "")
            )
            acct_number = (
                acct.get("accountNumberPvtEncrypt")
                or acct.get("accountNumber", "")
            )
            acct_name = (
                acct.get("nickname")
                or details.get("accountNickname")
                or acct.get("nickName")
                or acct.get("name", f"Account {acct_number}")
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

            # Use last 4 of account number as external_id
            external_id = acct_number[-4:] if acct_number else str(acct_id)[:8]
            account_type = _resolve_account_type(acct_type_str)

            account = db.get_or_create_account(
                name=acct_name,
                account_type=account_type,
                institution="ally",
                external_id=external_id,
            )
            log.info("Synced: %s ••%s [%s]", acct_name, external_id, account_type.value)

            # Record balance
            if current_balance is not None:
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=date.today(),
                        balance=float(current_balance),
                        source="ally_api",
                        raw_file_ref=raw_key,
                    )
                )
                log.info("  Balance: $%s", f"{current_balance:,.2f}")

            # Fetch transactions — Ally returns the same consolidated feed for all
            # checking accounts, so we track fingerprints to avoid duplicates.
            try:
                txns_raw = _fetch_all_transactions(token, acct_id, cookies)
                log.info("  Fetched %d transactions", len(txns_raw))

                # Store raw transactions
                txn_key = f"ally/{timestamp}_{external_id}_transactions.json"
                store.put(txn_key, json.dumps(txns_raw, indent=2).encode())

                txn_count = 0
                for txn in txns_raw:
                    txn_date_str = txn.get("transactionPostingDate", "")
                    txn_amount = txn.get("transactionAmountPvtEncrypt")
                    txn_desc = txn.get("transactionDescription", "")

                    if txn_amount is None or not txn_date_str:
                        continue

                    # Parse date — format is "2026-03-11T03:55:27-04:00"
                    txn_date = date.fromisoformat(txn_date_str[:10])

                    fingerprint = (txn_date_str[:10], float(txn_amount), txn_desc)
                    if fingerprint in seen_transactions:
                        continue
                    seen_transactions.add(fingerprint)

                    db.insert_transaction(
                        Transaction(
                            account_id=account.id,
                            date=txn_date,
                            amount=float(txn_amount),
                            description=txn_desc,
                            category=txn.get("transactionType"),
                            raw_file_ref=txn_key,
                        )
                    )
                    txn_count += 1

                log.info("  Stored %d transactions (skipped %d duplicates)",
                         txn_count, len(txns_raw) - txn_count)

            except Exception as e:
                log.warning("  Could not fetch transactions for %s: %s", acct_name, e)

            # Fetch monthly trends
            try:
                charts = _api_request(
                    token,
                    f"/acs/v1/bank-accounts/charts/{acct_id}",
                    cookies=cookies,
                )
                store.put(
                    f"ally/{timestamp}_{external_id}_charts.json",
                    json.dumps(charts, indent=2).encode(),
                )
                trends = charts.get("monthlyTrends", [])
                log.info("  Stored %d months of income/expense trends", len(trends))
            except Exception as e:
                log.warning("  Could not fetch charts for %s: %s", acct_name, e)

            # Fetch account details
            try:
                details = _api_request(
                    token,
                    f"/acs/v1/bank-accounts/{acct_id}",
                    cookies=cookies,
                )
                store.put(
                    f"ally/{timestamp}_{external_id}_details.json",
                    json.dumps(details, indent=2).encode(),
                )
                log.info("  Stored account details")
            except Exception as e:
                log.warning("  Could not fetch details for %s: %s", acct_name, e)

        db.insert_ingestion_record(
            IngestionRecord(
                source="ally_api",
                status=IngestionStatus.SUCCESS,
                raw_file_ref=raw_key,
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )

    except Exception as e:
        log.error("Ally API sync failed: %s", e)
        db.insert_ingestion_record(
            IngestionRecord(
                source="ally_api",
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise
