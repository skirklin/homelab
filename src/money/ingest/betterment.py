"""Betterment ingester — uses cookie relay + GraphQL API."""

import base64
import json
import logging
import re
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from money.config import cookie_relay_path
from money.db import Database
from money.ingest.common import ts_to_date
from money.ingest.schemas import (
    BMHoldingsResponse,
    BMPerformanceResponse,
    BMPurposeResponse,
    BMSidebarResponse,
)
from money.models import AccountType, Balance, Holding, IngestionRecord, IngestionStatus
from money.storage import RawStore

log = logging.getLogger(__name__)

GRAPHQL_URL = "https://wwws.betterment.com/api/graphql/web"

# Map Betterment GraphQL __typename to our AccountType
ACCOUNT_TYPE_MAP: dict[str, AccountType] = {
    "ManagedAccount": AccountType.BROKERAGE,
    "CashAccount": AccountType.SAVINGS,
    "CheckingAccount": AccountType.CHECKING,
    "DirectTradingAccount": AccountType.BROKERAGE,
}

# Override by account name keywords (e.g. "Traditional IRA" → IRA)
IRA_KEYWORDS = {"ira", "roth", "traditional ira", "roth ira", "sep ira", "rollover ira"}
FOUR_OH_ONE_K_KEYWORDS = {"401k", "401(k)"}

SIDEBAR_ACCOUNTS_QUERY = """\
query SidebarAccounts @operationServiceConfig(feature: "app_home") {
  envelopes {
    id
    accountsDescription
    orderPosition
    purpose {
      id
      name
      __typename
    }
    accounts {
      __typename
      id
      name
      ... on ManagedAccount {
        nameOverride
        accountDescription
        __typename
      }
      ... on DirectTradingAccount {
        nameOverride
        accountDescription
        __typename
      }
      ... on CashAccount {
        nameOverride
        accountDescription
        __typename
      }
      ... on CheckingAccount {
        remote {
          id
          checkingAccountId: legacyId
          name
          __typename
        }
        __typename
      }
    }
    __typename
  }
}"""

PURPOSE_HEADER_QUERY = """\
query PurposeHeader($id: ID!) @operationServiceConfig(feature: "envelope_details") {
  purpose(id: $id) {
    id
    name
    envelope {
      id
      balance
      legalSubAccounts {
        id
        legacySubAccountId
        legalAccount {
          taxationType
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}"""

PERFORMANCE_HISTORY_QUERY = """\
query EnvelopeAccountPerformanceHistory($id: ID!, $dateRangeOption: DateRangeOption) \
@operationServiceConfig(feature: "envelope_performance") {
  account: envelopeAccount(id: $id) {
    id
    ... on ManagedAccount {
      id
      legacyGoalId
      balance(includePending: true)
      performanceHistory(dateRangeOption: $dateRangeOption) {
        timeSeries {
          ...PerformanceHistoryItem
          __typename
        }
        recencyDescription
        __typename
      }
      performanceTotals(dateRangeOption: $dateRangeOption) {
        investing {
          earned
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
  disclosures {
    performanceDisclosure
    projectionReturnsDisclosure
    projectionReturnsAssumptionsDisclosure
    __typename
  }
}

fragment PerformanceHistoryItem on PerformanceHistoryItem {
  date
  balance
  invested
  earned
  __typename
}"""


HOLDINGS_QUERY = """\
query EnvelopeAccountHoldings($id: ID!) \
@operationServiceConfig(feature: "envelope_holdings") {
  account: envelopeAccount(id: $id) {
    id
    ... on ManagedAccount {
      securityGroupPositions {
        amount
        currentWeight
        securityGroup {
          name
          targetWeight
          __typename
        }
        securityPositions {
          amount
          shares
          security {
            symbol
            ... on SecurityFund {
              name
              __typename
            }
            __typename
          }
          financialSecurity {
            name
            symbol
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}"""


def _load_cookies(profile: str | None = None) -> dict[str, str]:
    """Load relayed cookies from the Chrome extension."""
    path = cookie_relay_path("betterment", profile) if profile else cookie_relay_path("betterment")
    if not path.exists() and profile:
        # Fall back to institution-level cookie file
        path = cookie_relay_path("betterment")
    if not path.exists():
        raise FileNotFoundError(
            "No cookies found for betterment. Log into Betterment in Chrome and "
            "click the Cookies button in the extension."
        )

    data = json.loads(path.read_text())
    cookies: dict[str, str] = {}
    for c in data.get("cookies", []):
        cookies[c["name"]] = c["value"]

    return cookies


def _fetch_csrf_token(cookies: dict[str, str]) -> str:
    """Fetch CSRF token from Betterment's HTML page (Rails meta tag)."""
    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
    req = urllib.request.Request("https://wwws.betterment.com/app")
    req.add_header("Cookie", cookie_str)
    req.add_header("User-Agent", (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ))
    req.add_header("Accept", "text/html")

    resp = urllib.request.urlopen(req)
    html = resp.read().decode()

    match = re.search(r'<meta\s+name="csrf-token"\s+content="([^"]+)"', html)
    if not match:
        match = re.search(r'content="([^"]+)"\s+name="csrf-token"', html)
    if not match:
        raise ValueError("Could not find CSRF token in Betterment HTML page")
    return match.group(1)


def _graphql(
    cookies: dict[str, str],
    csrf_token: str,
    operation_name: str,
    query: str,
    variables: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Execute a GraphQL query against Betterment's API."""
    payload = json.dumps({
        "operationName": operation_name,
        "query": query,
        "variables": variables or {},
    }).encode()

    req = urllib.request.Request(GRAPHQL_URL, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))
    req.add_header("X-CSRF-Token", csrf_token)
    req.add_header("User-Agent", (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ))

    resp = urllib.request.urlopen(req)
    result: dict[str, Any] = json.loads(resp.read())
    if "errors" in result:
        log.warning("GraphQL errors for %s: %s", operation_name, result["errors"])
    return result


def decode_account_id(graphql_id: str) -> str:
    """Decode base64 GraphQL ID like 'ManagedAccount:uuid' → uuid."""
    try:
        decoded = base64.b64decode(graphql_id).decode()
        if ":" in decoded:
            return decoded.split(":", 1)[1]
    except Exception:
        pass
    return graphql_id


def _resolve_account_type(typename: str, account_name: str) -> AccountType:
    """Map Betterment account type to our AccountType, with name-based overrides."""
    name_lower = account_name.lower()
    if any(kw in name_lower for kw in FOUR_OH_ONE_K_KEYWORDS):
        return AccountType.FOUR_OH_ONE_K
    if any(kw in name_lower for kw in IRA_KEYWORDS):
        return AccountType.IRA
    return ACCOUNT_TYPE_MAP.get(typename, AccountType.BROKERAGE)


def cents_to_dollars(cents: int | None) -> float | None:
    """Convert Betterment's cent amounts to dollars."""
    if cents is None:
        return None
    return cents / 100.0


def _build_display_name(
    acct_name: str,
    purpose_name: str,
    acct_typename: str,
    accounts: list[Any],
) -> str:
    """Build the display name for a Betterment account."""
    display_name = acct_name or purpose_name or acct_typename
    if len(accounts) > 1 or (acct_name and purpose_name and purpose_name != acct_name):
        display_name = f"{purpose_name} — {acct_name or acct_typename}"
    return display_name


def parse_raw_betterment(
    db: Database,
    inst_dir: Path,
    timestamp: str,
    profile: str | None,
) -> dict[str, int]:
    """Parse raw Betterment GraphQL captures for a given timestamp and write to DB.

    Reads:
      {inst_dir}/{timestamp}_sidebar.json
      {inst_dir}/{timestamp}_{envelope_id}_purpose.json
      {inst_dir}/{timestamp}_{acct_external_id}_performance.json
      {inst_dir}/{timestamp}_{acct_external_id}_holdings.json

    Returns a summary dict with counts written.
    """
    as_of = ts_to_date(timestamp)

    sidebar: BMSidebarResponse = json.loads(
        (inst_dir / f"{timestamp}_sidebar.json").read_text()
    )
    envelopes = sidebar["data"]["envelopes"]
    raw_key = f"betterment/{timestamp}_sidebar.json"

    account_count = 0

    for envelope in envelopes:
        envelope_id = envelope["id"]
        purpose_raw = envelope.get("purpose")
        purpose_name = purpose_raw["name"] if purpose_raw else "Unknown"
        accounts = envelope["accounts"]

        # Get envelope balance from purpose file
        envelope_balance: float | None = None
        if purpose_raw is not None:
            purpose_path = inst_dir / f"{timestamp}_{envelope_id}_purpose.json"
            if purpose_path.exists():
                purpose_resp: BMPurposeResponse = json.loads(purpose_path.read_text())
                purpose_obj = purpose_resp["data"]["purpose"]
                envelope_balance = cents_to_dollars(purpose_obj["envelope"]["balance"])

        for acct in accounts:
            acct_graphql_id = acct["id"]
            acct_typename = acct.get("__typename", "")
            acct_name = acct.get("nameOverride") or acct.get("name", "")
            acct_external_id = decode_account_id(acct_graphql_id)

            account_type = _resolve_account_type(acct_typename, acct_name)
            display_name = _build_display_name(acct_name, purpose_name, acct_typename, accounts)

            account = db.get_or_create_account(
                name=display_name,
                account_type=account_type,
                institution="betterment",
                external_id=acct_external_id,
                profile=profile,
            )
            account_count += 1

            # Performance history + balance
            balance: float | None = None
            perf_path = inst_dir / f"{timestamp}_{acct_external_id}_performance.json"
            if perf_path.exists():
                perf_resp: BMPerformanceResponse = json.loads(perf_path.read_text())
                acct_perf = perf_resp["data"]["account"]
                if acct_perf is not None:
                    balance = cents_to_dollars(acct_perf.get("balance"))

                    perf_history = acct_perf.get("performanceHistory")
                    time_series = perf_history["timeSeries"] if perf_history else []
                    if time_series:
                        perf_rows: list[tuple[str, str, float, float | None, float | None]] = []
                        for point in time_series:
                            pbal = point["balance"]
                            perf_rows.append((
                                account.id,
                                point["date"],
                                pbal / 100.0,
                                cents_to_dollars(point["invested"]),
                                cents_to_dollars(point["earned"]),
                            ))
                        db.insert_performance_batch(perf_rows)

            # Fallback to envelope balance
            if balance is None and envelope_balance is not None:
                balance = (
                    envelope_balance if len(accounts) == 1
                    else envelope_balance / len(accounts)
                )

            if balance is not None:
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=as_of,
                        balance=balance,
                        source="betterment_graphql",
                        raw_file_ref=raw_key,
                    )
                )

            # Holdings for managed accounts
            if acct_typename == "ManagedAccount":
                holdings_filename = f"{timestamp}_{acct_external_id}_holdings.json"
                holdings_key = f"betterment/{holdings_filename}"
                holdings_path = inst_dir / holdings_filename
                if holdings_path.exists():
                    holdings_resp: BMHoldingsResponse = json.loads(holdings_path.read_text())
                    acct_holdings = holdings_resp["data"]["account"]
                    if acct_holdings is not None:
                        groups = acct_holdings.get("securityGroupPositions", [])
                        holding_rows: list[Holding] = []
                        for group in groups:
                            group_name = group["securityGroup"]["name"]
                            for pos in group["securityPositions"]:
                                amount_cents = pos["amount"]
                                security = pos["security"]
                                fin_sec = pos["financialSecurity"]
                                symbol = security.get("symbol") or fin_sec.get("symbol")
                                name = (
                                    security.get("name")
                                    or fin_sec.get("name")
                                    or symbol
                                    or ""
                                )
                                holding_rows.append(Holding(
                                    account_id=account.id,
                                    as_of=as_of,
                                    symbol=symbol,
                                    name=name,
                                    asset_class=group_name,
                                    shares=float(pos["shares"]),
                                    value=amount_cents / 100.0 if amount_cents else 0.0,
                                    source="betterment_graphql",
                                    raw_file_ref=holdings_key,
                                ))
                        if holding_rows:
                            db.insert_holdings_batch(holding_rows)

        log.info("Betterment: parsed snapshot %s (%d envelopes)", timestamp, len(envelopes))

    return {"accounts": account_count}


def sync_betterment(db: Database, store: RawStore, profile: str | None = None) -> None:
    """Sync Betterment accounts and balances via GraphQL API."""
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")

    try:
        cookies = _load_cookies(profile)
        log.info("Loaded %d cookies for Betterment (login: %s)", len(cookies), profile)

        csrf_token = _fetch_csrf_token(cookies)
        log.info("Fetched CSRF token")

        # 1. Get all envelopes and accounts
        sidebar_data = _graphql(cookies, csrf_token, "SidebarAccounts", SIDEBAR_ACCOUNTS_QUERY)
        envelopes = sidebar_data.get("data", {}).get("envelopes", [])
        log.info("Got %d envelope(s) from Betterment", len(envelopes))

        raw_key = f"betterment/{timestamp}_sidebar.json"
        store.put(raw_key, json.dumps(sidebar_data, indent=2).encode())

        # 2. For each envelope, get balance via PurposeHeader
        for envelope in envelopes:
            envelope_id = envelope["id"]
            purpose_raw = envelope.get("purpose")
            purpose_name = purpose_raw.get("name", "Unknown") if purpose_raw else "Unknown"
            accounts = envelope.get("accounts", [])

            if purpose_raw is not None:
                purpose_data = _graphql(
                    cookies, csrf_token, "PurposeHeader", PURPOSE_HEADER_QUERY,
                    variables={"id": envelope_id},
                )
                store.put(
                    f"betterment/{timestamp}_{envelope_id}_purpose.json",
                    json.dumps(purpose_data, indent=2).encode(),
                )

            log.info("Envelope '%s': %d account(s)", purpose_name, len(accounts))

            # 3. For each account, fetch performance and holdings
            for acct in accounts:
                acct_graphql_id = acct["id"]
                acct_typename = acct.get("__typename", "")
                acct_name = acct.get("nameOverride") or acct.get("name", "")
                acct_external_id = decode_account_id(acct_graphql_id)
                display_name = _build_display_name(acct_name, purpose_name, acct_typename, accounts)

                # Performance history
                try:
                    perf_data = _graphql(
                        cookies, csrf_token,
                        "EnvelopeAccountPerformanceHistory",
                        PERFORMANCE_HISTORY_QUERY,
                        variables={
                            "id": acct_graphql_id,
                            "dateRangeOption": "ALL_TIME",
                        },
                    )
                    store.put(
                        f"betterment/{timestamp}_{acct_external_id}_performance.json",
                        json.dumps(perf_data, indent=2).encode(),
                    )
                except Exception as e:
                    log.warning("  Could not fetch performance for %s: %s", display_name, e)

                # Holdings for managed accounts
                if acct_typename == "ManagedAccount":
                    try:
                        holdings_data = _graphql(
                            cookies, csrf_token,
                            "EnvelopeAccountHoldings",
                            HOLDINGS_QUERY,
                            variables={"id": acct_graphql_id},
                        )
                        store.put(
                            f"betterment/{timestamp}_{acct_external_id}_holdings.json",
                            json.dumps(holdings_data, indent=2).encode(),
                        )
                    except Exception as e:
                        log.warning("  Could not fetch holdings for %s: %s", display_name, e)

        # Parse all raw data and write to DB
        from money.config import DATA_DIR as _DATA_DIR
        inst_dir = _DATA_DIR / "raw" / "betterment"
        parse_raw_betterment(db, inst_dir, timestamp, profile)

        db.insert_ingestion_record(
            IngestionRecord(
                source="betterment",
                profile=profile,
                status=IngestionStatus.SUCCESS,
                raw_file_ref=raw_key,
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )

    except Exception as e:
        log.error("Betterment sync failed: %s", e)
        db.insert_ingestion_record(
            IngestionRecord(
                source="betterment",
                profile=profile,
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise
