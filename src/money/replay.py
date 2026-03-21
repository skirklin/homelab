"""Replay ingestion from raw captures — rebuilds the database from stored API responses."""

import json
import logging
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

from money.db import Database
from money.models import (
    AccountType,
    Balance,
    Holding,
    IngestionRecord,
    IngestionStatus,
    Transaction,
)

log = logging.getLogger(__name__)


def replay_all(db_path: str, raw_dir: Path) -> None:
    """Delete and rebuild the database from raw captures."""
    db_file = Path(db_path)
    if db_file.exists():
        db_file.unlink()
        log.info("Deleted existing database: %s", db_path)
    # Also clean up WAL/SHM files
    for suffix in ("-wal", "-shm"):
        wal = db_file.with_name(db_file.name + suffix)
        if wal.exists():
            wal.unlink()

    db = Database(db_path)
    db.initialize()
    log.info("Initialized fresh database: %s", db_path)

    try:
        _replay_ally(db, raw_dir)
        _replay_betterment(db, raw_dir)
        _replay_wealthfront(db, raw_dir)
        _replay_capital_one(db, raw_dir)
        _replay_chase(db, raw_dir)
        _replay_morgan_stanley(db, raw_dir)

        from money.benchmarks import enrich_holdings_asset_classes
        from money.categorize import apply_rules

        enriched = enrich_holdings_asset_classes(db)
        log.info("Enriched %d holdings.", enriched)
        tagged = apply_rules(db)
        log.info("Categorized %d transactions.", tagged)
    finally:
        db.close()

    log.info("Replay complete.")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TS_RE = re.compile(r"^(\d{8}_\d{6})_")


def _find_timestamps(raw_dir: Path, institution: str, anchor: str) -> list[str]:
    """Find all sync timestamps for an institution that have the anchor file.

    Returns timestamps sorted oldest-first.
    """
    inst_dir = raw_dir / institution
    if not inst_dir.exists():
        return []
    timestamps: set[str] = set()
    for f in inst_dir.iterdir():
        if f.name.endswith(f"_{anchor}") or f.name == anchor:
            m = _TS_RE.match(f.name)
            if m:
                timestamps.add(m.group(1))
    return sorted(timestamps)


def _read_json(path: Path) -> Any:
    """Read and parse a JSON file, or return None if missing."""
    if not path.exists():
        return None
    return json.loads(path.read_text())


def _ts_to_date(ts: str) -> date:
    """Convert a YYYYMMDD_HHMMSS timestamp to a date."""
    return date(int(ts[:4]), int(ts[4:6]), int(ts[6:8]))


# ---------------------------------------------------------------------------
# Ally
# ---------------------------------------------------------------------------


def _replay_ally(db: Database, raw_dir: Path) -> None:
    """Replay Ally accounts and transactions from raw API captures."""
    from money.ingest.ally_api import ACCOUNT_TYPE_MAP as ALLY_TYPE_MAP

    inst_dir = raw_dir / "ally"
    if not inst_dir.exists():
        log.info("No Ally raw data found, skipping.")
        return

    # Find all account snapshots (from API captures)
    account_timestamps = _find_timestamps(raw_dir, "ally", "accounts.json")

    # Also check extension captures
    ext_files = sorted(inst_dir.glob("extension_*.json"))

    if not account_timestamps and not ext_files:
        log.info("No Ally raw data found, skipping.")
        return

    seen_transactions: set[tuple[str, float, str]] = set()

    # Process API captures (oldest first so latest wins)
    for ts in account_timestamps:
        as_of = _ts_to_date(ts)
        accounts_data = _read_json(inst_dir / f"{ts}_accounts.json")
        if not accounts_data:
            continue

        # Support both old ("data" key) and current ("accounts" key) formats
        accounts: list[dict[str, Any]] = (
            accounts_data.get("accounts") or accounts_data.get("data") or []
        )
        raw_key = f"ally/{ts}_accounts.json"

        for acct in accounts:
            acct_number = (
                acct.get("accountNumberPvtEncrypt")
                or acct.get("accountNumber", "")
            )
            details = acct.get("domainDetails", {})
            acct_name = (
                acct.get("nickname")
                or details.get("accountNickname")
                or acct.get("nickName")
                or acct.get("name")
                or f"Account {str(acct_number)[-4:]}"
            )
            # Skip external/linked accounts
            if details.get("externalAccountIndicator"):
                continue

            acct_type_str = acct.get("accountType") or acct.get("type", "DDA")
            status = acct.get("accountStatus") or acct.get("status", "")
            current_balance = (
                acct.get("currentBalance")
                or acct.get("balance", {}).get("current")
            )

            if status.upper() != "ACTIVE":
                continue

            external_id = str(acct_number)[-4:] if acct_number else ""
            account_type = ALLY_TYPE_MAP.get(acct_type_str, AccountType.CHECKING)

            account = db.get_or_create_account(
                name=acct_name,
                account_type=account_type,
                institution="ally",
                external_id=external_id,
            )

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

            # Replay transactions (deduped across accounts)
            txn_path = inst_dir / f"{ts}_{external_id}_transactions.json"
            txns_raw = _read_json(txn_path)
            if not isinstance(txns_raw, list):
                continue

            txn_key = f"ally/{ts}_{external_id}_transactions.json"
            txn_list: list[dict[str, Any]] = list(txns_raw)
            txn_count = 0
            for txn in txn_list:
                txn_date_str = txn.get("transactionPostingDate", "")
                txn_amount = txn.get("transactionAmountPvtEncrypt")
                txn_desc = txn.get("transactionDescription", "")

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
            if txn_count:
                log.info("  Ally %s: %d transactions", external_id, txn_count)

        log.info("Replayed Ally API snapshot %s: %d accounts", ts, len(accounts))

    # Process extension captures (account metadata + balances)
    for ext_path in ext_files:
        data = _read_json(ext_path)
        if not data:
            continue
        ext_accounts: list[dict[str, Any]] = data.get("accounts", [])
        scraped_at = data.get("scraped_at", "")
        as_of = date.fromisoformat(scraped_at[:10]) if scraped_at else date.today()

        for acct in ext_accounts:
            name = acct.get("name", "")
            ext_id = acct.get("external_id", "")
            raw_type = acct.get("account_type", "checking")

            if not name or not ext_id:
                continue

            type_map = {"checking": AccountType.CHECKING, "savings": AccountType.SAVINGS}
            account = db.get_or_create_account(
                name=name,
                account_type=type_map.get(raw_type, AccountType.CHECKING),
                institution="ally",
                external_id=ext_id,
            )

            bal = acct.get("balance")
            if bal is not None:
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=as_of,
                        balance=float(bal),
                        source="ally_extension",
                        raw_file_ref=f"ally/{ext_path.name}",
                    )
                )

    db.insert_ingestion_record(
        IngestionRecord(
            source="ally",
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
            started_at=datetime.now(),
            finished_at=datetime.now(),
        )
    )


# ---------------------------------------------------------------------------
# Betterment
# ---------------------------------------------------------------------------


def _replay_betterment(db: Database, raw_dir: Path) -> None:
    """Replay Betterment accounts, balances, performance, and holdings."""
    from money.ingest.betterment import ACCOUNT_TYPE_MAP as BM_TYPE_MAP
    from money.ingest.betterment import (
        FOUR_OH_ONE_K_KEYWORDS,
        IRA_KEYWORDS,
        cents_to_dollars,
        decode_account_id,
    )

    timestamps = _find_timestamps(raw_dir, "betterment", "sidebar.json")
    if not timestamps:
        log.info("No Betterment raw data found, skipping.")
        return

    inst_dir = raw_dir / "betterment"

    for ts in timestamps:
        as_of = _ts_to_date(ts)
        sidebar = _read_json(inst_dir / f"{ts}_sidebar.json")
        if not sidebar:
            continue

        envelopes: list[dict[str, Any]] = sidebar.get("data", {}).get("envelopes", [])

        for envelope in envelopes:
            envelope_id = envelope["id"]
            purpose_raw = envelope.get("purpose")
            purpose_name = purpose_raw.get("name", "Unknown") if purpose_raw else "Unknown"
            accounts = envelope.get("accounts", [])

            # Get envelope balance from purpose file
            envelope_balance: float | None = None
            if purpose_raw is not None:
                purpose_data = _read_json(inst_dir / f"{ts}_{envelope_id}_purpose.json")
                if purpose_data:
                    purpose_obj = purpose_data.get("data", {}).get("purpose")
                    if purpose_obj:
                        bal_cents = purpose_obj.get("envelope", {}).get("balance")
                        envelope_balance = cents_to_dollars(bal_cents)

            for acct in accounts:
                acct_graphql_id = acct["id"]
                acct_typename = acct.get("__typename", "")
                acct_name = acct.get("nameOverride") or acct.get("name", "")
                acct_external_id = decode_account_id(acct_graphql_id)

                # Resolve account type
                name_lower = acct_name.lower()
                if any(kw in name_lower for kw in FOUR_OH_ONE_K_KEYWORDS):
                    account_type = AccountType.FOUR_OH_ONE_K
                elif any(kw in name_lower for kw in IRA_KEYWORDS):
                    account_type = AccountType.IRA
                else:
                    account_type = BM_TYPE_MAP.get(acct_typename, AccountType.BROKERAGE)

                display_name = acct_name or f"{purpose_name} — {acct_typename}"

                account = db.get_or_create_account(
                    name=display_name,
                    account_type=account_type,
                    institution="betterment",
                    external_id=acct_external_id,
                )

                # Performance history + balance
                balance: float | None = None
                perf_data = _read_json(inst_dir / f"{ts}_{acct_external_id}_performance.json")
                if perf_data:
                    acct_data = perf_data.get("data", {}).get("account", {})
                    bal_cents = acct_data.get("balance")
                    balance = cents_to_dollars(bal_cents)

                    time_series: list[dict[str, Any]] = acct_data.get("performanceHistory", {}).get(
                        "timeSeries", []
                    )
                    if time_series:
                        perf_rows: list[tuple[str, str, float, float | None, float | None]] = []
                        for point in time_series:
                            pbal = point.get("balance")
                            if pbal is not None:
                                perf_rows.append(
                                    (
                                        account.id,
                                        point["date"],
                                        pbal / 100.0,
                                        cents_to_dollars(point.get("invested")),
                                        cents_to_dollars(point.get("earned")),
                                    )
                                )
                        db.insert_performance_batch(perf_rows)

                # Fallback to envelope balance
                if balance is None and envelope_balance is not None:
                    balance = (
                        envelope_balance if len(accounts) == 1 else envelope_balance / len(accounts)
                    )

                if balance is not None:
                    db.insert_balance(
                        Balance(
                            account_id=account.id,
                            as_of=as_of,
                            balance=balance,
                            source="betterment_graphql",
                            raw_file_ref=f"betterment/{ts}_sidebar.json",
                        )
                    )

                # Holdings
                if acct_typename == "ManagedAccount":
                    holdings_data = _read_json(inst_dir / f"{ts}_{acct_external_id}_holdings.json")
                    if holdings_data:
                        acct_holdings = holdings_data.get("data", {}).get("account", {})
                        groups = acct_holdings.get("securityGroupPositions", [])
                        holding_rows: list[Holding] = []
                        for group in groups:
                            group_name = group.get("securityGroup", {}).get("name", "")
                            for pos in group.get("securityPositions", []):
                                amount_cents = pos.get("amount")
                                security = pos.get("security", {})
                                fin_sec = pos.get("financialSecurity", {})
                                symbol = security.get("symbol") or fin_sec.get("symbol")
                                name = security.get("name") or fin_sec.get("name") or symbol or ""
                                holding_rows.append(
                                    Holding(
                                        account_id=account.id,
                                        as_of=as_of,
                                        symbol=symbol,
                                        name=name,
                                        asset_class=group_name,
                                        shares=float(pos.get("shares", 0)),
                                        value=amount_cents / 100.0 if amount_cents else 0.0,
                                        source="betterment_graphql",
                                        raw_file_ref=f"betterment/{ts}_{acct_external_id}_holdings.json",
                                    )
                                )
                        if holding_rows:
                            db.insert_holdings_batch(holding_rows)

        log.info("Replayed Betterment snapshot %s", ts)

    db.insert_ingestion_record(
        IngestionRecord(
            source="betterment",
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
            started_at=datetime.now(),
            finished_at=datetime.now(),
        )
    )


# ---------------------------------------------------------------------------
# Wealthfront
# ---------------------------------------------------------------------------


def _replay_wealthfront(db: Database, raw_dir: Path) -> None:
    """Replay Wealthfront accounts, balances, performance, holdings, transfers."""
    from money.ingest.wealthfront import ACCOUNT_TYPE_MAP as WF_TYPE_MAP
    from money.ingest.wealthfront import ingest_transfers

    timestamps = _find_timestamps(raw_dir, "wealthfront", "overviews.json")
    if not timestamps:
        log.info("No Wealthfront raw data found, skipping.")
        return

    inst_dir = raw_dir / "wealthfront"

    for ts in timestamps:
        as_of = _ts_to_date(ts)
        overviews_data = _read_json(inst_dir / f"{ts}_overviews.json")
        if not overviews_data:
            continue

        overviews: list[dict[str, Any]] = overviews_data.get("overviews", [])

        for overview in overviews:
            acct_id = overview.get("accountId", "")
            acct_type_str = overview.get("accountType", "")
            display_name = overview.get("accountDisplayName", f"Account {acct_id}")
            state = overview.get("state", "")
            total_value = overview.get("accountValueSummary", {}).get("totalValue")

            if not acct_id or state not in ("FUNDED", "OPENED"):
                continue

            account_type = WF_TYPE_MAP.get(acct_type_str, AccountType.BROKERAGE)
            account = db.get_or_create_account(
                name=display_name,
                account_type=account_type,
                institution="wealthfront",
                external_id=acct_id,
            )

            if total_value is not None:
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=as_of,
                        balance=float(total_value),
                        source="wealthfront_api",
                        raw_file_ref=f"wealthfront/{ts}_overviews.json",
                    )
                )

            # Performance history
            perf_data = _read_json(inst_dir / f"{ts}_{acct_id}_performance.json")
            if perf_data:
                history: list[dict[str, Any]] = perf_data.get("historyList", [])
                perf_rows: list[tuple[str, str, float, float | None, float | None]] = []
                for entry in history:
                    mv = entry.get("marketValue")
                    if mv is not None:
                        invested = entry.get("sumNetDeposits")
                        earned = (mv - invested) if invested is not None else None
                        perf_rows.append(
                            (
                                account.id,
                                entry["date"],
                                float(mv),
                                float(invested) if invested is not None else None,
                                float(earned) if earned is not None else None,
                            )
                        )
                if perf_rows:
                    db.insert_performance_batch(perf_rows)

            # Holdings from open lots
            lots_data = _read_json(inst_dir / f"{ts}_{acct_id}_open_lots.json")
            if lots_data and isinstance(lots_data, dict):
                lots_list: list[dict[str, Any]] = list(lots_data.get("openLotForDisplayList", []))
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
                        holding_rows.append(
                            Holding(
                                account_id=account.id,
                                as_of=as_of,
                                symbol=sym,
                                name=sym,
                                shares=agg["shares"],
                                value=agg["value"],
                                source="wealthfront_api",
                                raw_file_ref=f"wealthfront/{ts}_{acct_id}_open_lots.json",
                            )
                        )
                if holding_rows:
                    db.insert_holdings_batch(holding_rows)

            # Transfers as transactions
            transfers_data = _read_json(inst_dir / f"{ts}_{acct_id}_transfers.json")
            if transfers_data and isinstance(transfers_data, dict):
                transfers_key = f"wealthfront/{ts}_{acct_id}_transfers.json"
                ingest_transfers(db, account.id, transfers_data, transfers_key)

        log.info("Replayed Wealthfront snapshot %s: %d accounts", ts, len(overviews))

    db.insert_ingestion_record(
        IngestionRecord(
            source="wealthfront",
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
            started_at=datetime.now(),
            finished_at=datetime.now(),
        )
    )


# ---------------------------------------------------------------------------
# Capital One
# ---------------------------------------------------------------------------


def _replay_capital_one(db: Database, raw_dir: Path) -> None:
    """Replay Capital One credit card accounts and transactions."""
    timestamps = _find_timestamps(raw_dir, "capital_one", "accounts.json")
    if not timestamps:
        log.info("No Capital One raw data found, skipping.")
        return

    inst_dir = raw_dir / "capital_one"

    for ts in timestamps:
        as_of = _ts_to_date(ts)
        accounts_data = _read_json(inst_dir / f"{ts}_accounts.json")
        if not accounts_data:
            continue

        raw_accounts: list[dict[str, Any]] = accounts_data.get("accounts", [])
        raw_key = f"capital_one/{ts}_accounts.json"

        for raw_acct in raw_accounts:
            card_acct: dict[str, Any] = raw_acct.get("cardAccount", {})
            name_info: dict[str, Any] = card_acct.get("nameInfo", {})
            cycle_info: dict[str, Any] = card_acct.get("cycleInfo", {})

            display_name = name_info.get("displayName", name_info.get("name", "Unknown"))
            last_four = card_acct.get("plasticIdLastFour", "")

            account = db.get_or_create_account(
                name=display_name,
                account_type=AccountType.CREDIT_CARD,
                institution="capital_one",
                external_id=str(last_four),
            )

            current_balance = cycle_info.get("currentBalance")
            if current_balance is not None:
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=as_of,
                        balance=-float(current_balance),
                        source="capital_one_api",
                        raw_file_ref=raw_key,
                    )
                )

            # Transactions
            # Transaction files may be a single file or chunked (_0, _1, etc.)
            txn_files = sorted(inst_dir.glob(f"{ts}_{last_four}_transactions*.json"))
            if not txn_files:
                continue

            raw_entries: list[dict[str, Any]] = []
            txn_key = f"capital_one/{txn_files[0].name}"
            for txn_file in txn_files:
                txn_data = _read_json(txn_file)
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

            log.info("  Capital One %s: %d transactions", last_four, txn_count)

        log.info("Replayed Capital One snapshot %s", ts)

    db.insert_ingestion_record(
        IngestionRecord(
            source="capital_one",
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
            started_at=datetime.now(),
            finished_at=datetime.now(),
        )
    )


# ---------------------------------------------------------------------------
# Chase
# ---------------------------------------------------------------------------


def _replay_chase(db: Database, raw_dir: Path) -> None:
    """Replay Chase data from captured network logs."""
    from money.ingest.chase import extract_account_list, parse_chase_date

    inst_dir = raw_dir / "chase"
    if not inst_dir.exists():
        log.info("No Chase raw data found, skipping.")
        return

    # Find network log files
    log_files = sorted(inst_dir.glob("*_network_log.json"))
    if not log_files:
        log.info("No Chase network logs found, skipping.")
        return

    for log_file in log_files:
        m = _TS_RE.match(log_file.name)
        if not m:
            continue
        ts = m.group(1)
        as_of = _ts_to_date(ts)
        raw_key = f"chase/{log_file.name}"

        data = _read_json(log_file)
        if not data:
            continue

        # Parse network log entries (same logic as chase._load_network_log)
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

        account_list = extract_account_list(results["dashboard"])
        account_map: dict[int, dict[str, Any]] = {}
        for acct in account_list:
            account_map[acct.get("id", 0)] = acct

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
            )

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
                continue

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
                )

        log.info("Replayed Chase network log %s", ts)

    db.insert_ingestion_record(
        IngestionRecord(
            source="chase",
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
            started_at=datetime.now(),
            finished_at=datetime.now(),
        )
    )


# ---------------------------------------------------------------------------
# Morgan Stanley
# ---------------------------------------------------------------------------


def _replay_morgan_stanley(db: Database, raw_dir: Path) -> None:
    """Replay Morgan Stanley stock options/RSU data."""
    import contextlib

    from money.ingest.morgan_stanley import (
        parse_money,
    )
    from money.models import OptionGrant, PrivateValuation

    timestamps = _find_timestamps(raw_dir, "morgan_stanley", "portfolio_summary.json")
    if not timestamps:
        log.info("No Morgan Stanley raw data found, skipping.")
        return

    inst_dir = raw_dir / "morgan_stanley"

    for ts in timestamps:
        as_of = _ts_to_date(ts)
        summary_data = _read_json(inst_dir / f"{ts}_portfolio_summary.json")
        grants_data = _read_json(inst_dir / f"{ts}_grants.json")
        portfolio_data = _read_json(inst_dir / f"{ts}_portfolio.json")

        if not summary_data:
            continue

        summary: dict[str, Any] = summary_data.get("data", {})
        raw_grants: list[dict[str, Any]] = grants_data.get("data", []) if grants_data else []

        fmv_price_str: str = summary.get("valuedAtPrice", "0 USD")
        fmv_price = parse_money(fmv_price_str)

        account = db.get_or_create_account(
            name="Anthropic Stock Options",
            account_type=AccountType.STOCK_OPTIONS,
            institution="morgan_stanley",
            external_id="shareworks",
        )

        # Total balance
        total_value: float | None = None
        if portfolio_data:
            accounts_list: list[dict[str, Any]] = portfolio_data.get("accounts", [])
            if accounts_list:
                total_value = float(accounts_list[0].get("totalValue", {}).get("amount", 0))
        else:
            portfolio_items: list[dict[str, Any]] = summary.get("portfolioData", [])
            available_total = 0.0
            future_total = 0.0
            for item in portfolio_items:
                available_total += parse_money(item.get("availableValue", "0 USD"))
                for f in item.get("futureData", []):
                    future_total += parse_money(f.get("value", "0 USD"))
            total_value = available_total + future_total

        if total_value is not None:
            raw_key = f"morgan_stanley/{ts}_portfolio_summary.json"
            db.insert_balance(
                Balance(
                    account_id=account.id,
                    as_of=as_of,
                    balance=total_value,
                    source="morgan_stanley_api",
                    raw_file_ref=raw_key,
                )
            )

        # FMV
        if fmv_price > 0:
            db.insert_private_valuation(
                PrivateValuation(
                    account_id=account.id,
                    as_of=as_of,
                    fmv_per_share=fmv_price,
                    source="shareworks_409a",
                )
            )

        # Build vested quantity lookup from portfolio summary
        portfolio_items: list[dict[str, Any]] = list(summary.get("portfolioData", []))
        vested_by_instance: dict[str, tuple[int, float]] = {}
        for pi in portfolio_items:
            instance_name: str = pi.get("instanceName", "")
            avail_qty = int(pi.get("availableQuantity", 0))
            avail_val = parse_money(pi.get("availableValue", "0 USD"))
            if instance_name:
                vested_by_instance[instance_name] = (avail_qty, avail_val)

        # Grants
        from money.ingest.morgan_stanley import determine_grant_type

        for raw_grant in raw_grants:
            grant_date_str: str = raw_grant.get("grantDate", "")
            if not grant_date_str:
                continue

            grant_date = date.fromisoformat(grant_date_str)
            award_name: str = raw_grant.get("awardName", "")
            grant_name: str = raw_grant.get("grantName", "")
            quantity = int(raw_grant.get("quantityGranted", 0))

            strike_price = 0.0
            parts = grant_name.split("$")
            if len(parts) > 1:
                price_str = parts[-1].split()[0].rstrip(" -")
                with contextlib.suppress(ValueError):
                    strike_price = float(price_str)

            exercise_details: dict[str, Any] = raw_grant.get("exerciseDetails", {})
            vest_dates: list[str] = exercise_details.get("vestDates", [])
            parsed_vest_dates = [date.fromisoformat(d) for d in vest_dates]

            grant_type = determine_grant_type(award_name)
            vested_qty, vested_val = vested_by_instance.get(grant_name, (0, 0.0))

            expiration_str: str | None = raw_grant.get("expiredDate")
            expiration_date = date.fromisoformat(expiration_str) if expiration_str else None

            db.insert_option_grant(
                OptionGrant(
                    account_id=account.id,
                    grant_date=grant_date,
                    grant_type=grant_type,
                    total_shares=quantity,
                    vested_shares=vested_qty,
                    strike_price=strike_price,
                    vested_value=vested_val,
                    expiration_date=expiration_date,
                    vest_dates=parsed_vest_dates,
                )
            )

        log.info("Replayed Morgan Stanley snapshot %s", ts)

    db.insert_ingestion_record(
        IngestionRecord(
            source="morgan_stanley",
            status=IngestionStatus.SUCCESS,
            raw_file_ref="replay",
            started_at=datetime.now(),
            finished_at=datetime.now(),
        )
    )
