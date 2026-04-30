"""Chase ingester — parses captured network log data."""

import json as _json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from money.config import DATA_DIR
from money.db import Database
from money.ingest.common import ts_to_date
from money.ingest.schemas import (
    CHAccountTile,
    CHActivityAccount,
    CHActivityOptionsResponse,
    CHCardRewardsResponse,
    CHDashboardResponse,
    CHDdaDetailResponse,
    CHInvestmentBalancePoint,
    CHInvestmentDailyBalancesResponse,
    CHInvestmentMonthlyBalancesResponse,
    CHInvestmentPositionsResponse,
    CHNetworkLog,
    CHPortfolioAccountEntry,
    CHPortfolioOptionsResponse,
    CHTilesListResponse,
    CHTransactionsResponse,
)
from money.models import (
    AccountType,
    Balance,
    Holding,
    IngestionRecord,
    IngestionStatus,
    Transaction,
)
from money.storage import RawStore


@dataclass
class _InvestmentData:
    """Parsed investment data for one account (keyed by selectorIdentifier)."""

    selector_identifier: str
    positions: CHInvestmentPositionsResponse | None = None
    daily_balances: list[CHInvestmentBalancePoint] = field(default_factory=list)
    monthly_balances: list[CHInvestmentBalancePoint] = field(default_factory=list)
    account_meta: CHPortfolioAccountEntry | None = None

log = logging.getLogger(__name__)


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


def _selector_from_url(url: str) -> str | None:
    """Extract the `selector-identifier` query param from an investment URL."""
    qs = parse_qs(urlparse(url).query)
    vals = qs.get("selector-identifier", [])
    return vals[0] if vals else None


def _selector_from_request_body(request_body: str | None) -> str | None:
    """Extract `selectorIdentifier` from a JSON request body string."""
    if not request_body:
        return None
    try:
        data = _json.loads(request_body)
    except (ValueError, TypeError):
        return None
    val = data.get("selectorIdentifier") if isinstance(data, dict) else None
    return str(val) if val is not None else None


def _selector_from_positions_body(body: dict[str, object]) -> str | None:
    """Fallback: extract selectorIdentifier from a positions response body
    (via positionComponents[].digitalAccountIdentifier).

    The page-context fetch interceptor sometimes loses requestBody; the
    response always identifies the account inside its positionComponents.
    """
    positions = body.get("positions")
    if not isinstance(positions, list):
        return None
    for pos in positions:
        if not isinstance(pos, dict):
            continue
        components = pos.get("positionComponents")
        if not isinstance(components, list):
            continue
        for comp in components:
            if isinstance(comp, dict):
                val = comp.get("digitalAccountIdentifier")
                if val is not None:
                    return str(val)
    return None


def _parse_network_log_entries(
    data: CHNetworkLog,
) -> tuple[
    list[CHDdaDetailResponse],
    list[CHTransactionsResponse],
    list[CHCardRewardsResponse],
    list[CHDashboardResponse],
    dict[str, _InvestmentData],
    list[CHAccountTile],
]:
    """Parse a raw network log into categorised response lists.

    The fifth element maps selectorIdentifier -> _InvestmentData for Chase
    brokerage/managed investment accounts. The sixth is the flattened
    accountTiles[] from the dashboard/tiles/list cache embedded inside
    /app/data/list — the source of truth for credit-card statement balance.
    """
    dda_details: list[CHDdaDetailResponse] = []
    transactions: list[CHTransactionsResponse] = []
    card_rewards: list[CHCardRewardsResponse] = []
    dashboard: list[CHDashboardResponse] = []
    investments: dict[str, _InvestmentData] = {}
    tiles: list[CHAccountTile] = []
    seen_tile_masks: set[str] = set()

    def _get(selector: str) -> _InvestmentData:
        if selector not in investments:
            investments[selector] = _InvestmentData(selector_identifier=selector)
        return investments[selector]

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
        elif "portfolio/account/options/list2" in url:
            try:
                options_resp = CHPortfolioOptionsResponse.model_validate(body)
            except Exception:
                continue
            for acct in options_resp.accounts:
                is_invest = (
                    acct.accountCategoryType == "INVESTMENT"
                    or acct.groupType == "INVESTMENT"
                )
                if is_invest and acct.accountId:
                    _get(str(acct.accountId)).account_meta = acct
        elif "digital-investment-positions/v2/positions" in url:
            selector = (
                _selector_from_request_body(entry.requestBody)
                or _selector_from_positions_body(body)
            )
            if selector:
                _get(selector).positions = CHInvestmentPositionsResponse.model_validate(body)
        elif "digital-investment-portfolio/v2/balances/daily-balances" in url:
            selector = _selector_from_url(url)
            if selector:
                _get(selector).daily_balances = (
                    CHInvestmentDailyBalancesResponse.model_validate(body).dailyBalanceDetails
                )
        elif "digital-investment-portfolio/v2/balances/monthly-balances" in url:
            selector = _selector_from_url(url)
            if selector:
                _get(selector).monthly_balances = (
                    CHInvestmentMonthlyBalancesResponse.model_validate(body).monthlyBalanceDetails
                )
        elif "/svc/rl/accounts/l4/v1/app/data/list" in url:
            # Statement balance / available credit live inside the embedded
            # dashboard/tiles/list cache entry, not on a top-level URL.
            cache_entries = body.get("cache")
            if not isinstance(cache_entries, list):
                continue
            for cache_entry in cache_entries:
                if not isinstance(cache_entry, dict):
                    continue
                if cache_entry.get("url") != "/svc/rr/accounts/secure/v4/dashboard/tiles/list":
                    continue
                response_obj = cache_entry.get("response")
                if not isinstance(response_obj, dict):
                    continue
                try:
                    tiles_resp = CHTilesListResponse.model_validate(response_obj)
                except Exception:
                    continue
                for tile in tiles_resp.accountTiles:
                    if tile.mask in seen_tile_masks:
                        continue
                    seen_tile_masks.add(tile.mask)
                    tiles.append(tile)
    return dda_details, transactions, card_rewards, dashboard, investments, tiles


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
    dda_details, transactions, card_rewards, dashboard, investments, tiles = _parse_network_log_entries(raw_data)

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

    # Credit cards: account info comes from cardRewardsSummary, statement
    # balance comes from the dashboard tile (the rewards "balance" field is
    # actually rewards points — same as currentRewardsBalance).
    balance_count = 0
    card_tile_by_mask = {t.mask: t for t in tiles if t.accountTileType == "CARD"}
    for rewards_resp in card_rewards:
        for card in rewards_resp.cardRewardsSummary:
            mask = str(card.mask)
            account = db.get_or_create_account(
                name=f"{card.nickname} ({card.cardType.replace('_', ' ').title()})",
                account_type=AccountType.CREDIT_CARD,
                institution="chase",
                external_id=mask,
                profile=profile,
            )
            account_count += 1
            tile = card_tile_by_mask.get(mask)
            if tile and tile.tileDetail.currentBalance is not None:
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=as_of,
                        balance=-tile.tileDetail.currentBalance,
                        source="chase_account_tile",
                        raw_file_ref=raw_key,
                    )
                )
                balance_count += 1
                log.info(
                    "Chase card: %s ••%s balance=$%.2f available=$%.2f",
                    card.nickname, mask,
                    tile.tileDetail.currentBalance,
                    tile.tileDetail.availableBalance or 0.0,
                )
            else:
                log.warning("Chase card: %s ••%s — no tile balance found", card.nickname, mask)

    # Managed brokerage / investment accounts
    holding_count = 0
    for inv in investments.values():
        ext_id = f"inv:{inv.selector_identifier}"
        meta = inv.account_meta
        if meta and meta.nickname and meta.mask:
            # "MANAGED BROKERAGE ••9983"
            acct_name = f"{meta.nickname.title()} ••{meta.mask}"
        elif meta and meta.nickname:
            acct_name = meta.nickname.title()
        else:
            type_label = (
                inv.positions.positionsSummary.investmentAccountTypeNames[0]
                if inv.positions and inv.positions.positionsSummary.investmentAccountTypeNames
                else "Brokerage"
            ).title()
            acct_name = f"Chase {type_label} ({inv.selector_identifier})"
        account = db.get_or_create_account(
            name=acct_name,
            account_type=AccountType.BROKERAGE,
            institution="chase",
            external_id=ext_id,
            profile=profile,
        )
        account_count += 1
        log.info(
            "Chase investment: %s (selector=%s)",
            account.name, inv.selector_identifier,
        )

        # Current balance from positionsSummary
        if inv.positions:
            summary = inv.positions.positionsSummary
            summary_date = _parse_iso_date(summary.asOfDate) or as_of
            db.insert_balance(
                Balance(
                    account_id=account.id,
                    as_of=summary_date,
                    balance=summary.totalMarketValueAmount,
                    source="chase_network_log",
                    raw_file_ref=raw_key,
                )
            )
            balance_count += 1

            # Holdings
            batch: list[Holding] = []
            for pos in inv.positions.positions:
                pos_date = _parse_iso_date(pos.positionDate) or summary_date
                if pos.marketValue is None:
                    continue
                symbol = None
                if pos.securityIdDetail and isinstance(pos.securityIdDetail, dict):
                    s = pos.securityIdDetail.get("snapQuoteOptionSymbolCode")
                    if isinstance(s, str):
                        symbol = s
                batch.append(
                    Holding(
                        account_id=account.id,
                        as_of=pos_date,
                        name=pos.instrumentLongName or pos.instrumentShortName or "unknown",
                        shares=pos.tradedUnitQuantity,
                        value=pos.marketValue.baseValueAmount,
                        source="chase_network_log",
                        symbol=symbol,
                        asset_class=pos.assetCategoryName,
                        raw_file_ref=raw_key,
                    )
                )
            if batch:
                db.insert_holdings_batch(batch)
                holding_count += len(batch)

        # Balance history (daily, then monthly for older dates)
        for point in inv.daily_balances:
            d = _parse_iso_date(point.balanceDate)
            if d and point.balanceAmount > 0:
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=d,
                        balance=point.balanceAmount,
                        source="chase_network_log_daily",
                        raw_file_ref=raw_key,
                    )
                )
                balance_count += 1
        for point in inv.monthly_balances:
            d = _parse_iso_date(point.balanceDate)
            if d and point.balanceAmount > 0:
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=d,
                        balance=point.balanceAmount,
                        source="chase_network_log_monthly",
                        raw_file_ref=raw_key,
                    )
                )
                balance_count += 1

    log.info(
        "Chase: parsed network log %s — %d balances, %d holdings",
        timestamp, balance_count, holding_count,
    )
    return {
        "accounts": account_count,
        "transactions": txn_count_total,
        "balances": balance_count,
        "holdings": holding_count,
    }


def _parse_iso_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


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
