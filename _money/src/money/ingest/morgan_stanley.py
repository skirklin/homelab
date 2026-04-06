"""Morgan Stanley Shareworks ingester — parses captured network log data."""

import json
import logging
from datetime import date, datetime
from pathlib import Path
from typing import Any
from money.db import Database
from money.ingest.common import ts_to_date
from money.models import (
    AccountType,
    Balance,
    IngestionRecord,
    IngestionStatus,
    OptionGrant,
    PrivateValuation,
)
from money.storage import RawStore

log = logging.getLogger(__name__)


def parse_money(value: str) -> float:
    """Parse a Shareworks money string like '33671988.06 USD' to float."""
    return float(value.split()[0])


def determine_grant_type(award_name: str) -> str:
    """Classify a Shareworks award name into ISO, NQ, or RSU."""
    name = award_name.lower()
    if "iso" in name:
        return "ISO"
    if "nq" in name or "nqso" in name:
        return "NQ"
    if "rsu" in name:
        return "RSU"
    return award_name


def parse_raw_morgan_stanley(
    db: Database,
    inst_dir: Path,
    timestamp: str,
    profile: str | None,
) -> dict[str, int]:
    """Parse raw Morgan Stanley captures for a given timestamp and write to DB.

    Reads:
      {inst_dir}/{timestamp}_portfolio_summary.json
      {inst_dir}/{timestamp}_grants.json
      {inst_dir}/{timestamp}_portfolio.json   (optional legacy)

    Returns a summary dict with counts written.
    """
    as_of = ts_to_date(timestamp)

    from money.ingest.schemas import (
        MSGrantsResponse,
        MSPortfolioSummaryResponse,
    )

    summary_response = MSPortfolioSummaryResponse.model_validate_json(
        (inst_dir / f"{timestamp}_portfolio_summary.json").read_text()
    )
    grants_response = MSGrantsResponse.model_validate_json(
        (inst_dir / f"{timestamp}_grants.json").read_text()
    )
    summary = summary_response.data
    raw_grants = grants_response.data

    fmv_price = parse_money(summary.valuedAtPrice)

    account = db.get_or_create_account(
        name="Anthropic Stock Options",
        account_type=AccountType.STOCK_OPTIONS,
        institution="morgan_stanley",
        external_id="shareworks",
        profile=profile,
    )

    # Total balance from portfolio summary
    portfolio_items = summary.portfolioData
    available_total = 0.0
    future_total = 0.0
    for item in portfolio_items:
        available_total += parse_money(item.availableValue)
        for f in item.futureData:
            future_total += parse_money(f.value)
    total_value = available_total + future_total

    raw_key = f"morgan_stanley/{profile}/{timestamp}_portfolio_summary.json"

    db.insert_balance(
        Balance(
            account_id=account.id,
            as_of=as_of,
            balance=total_value,
            source="morgan_stanley_api",
            raw_file_ref=raw_key,
        )
    )

    # FMV (409A valuation)
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
    vested_by_instance: dict[str, tuple[int, float]] = {}
    for pi in portfolio_items:
        if pi.instanceName is None:
            continue  # skip cash holding items with no instance name
        avail_qty = int(pi.availableQuantity)
        avail_val = parse_money(pi.availableValue)
        vested_by_instance[pi.instanceName] = (avail_qty, avail_val)

    # Grants
    grant_count = 0
    for raw_grant in raw_grants:
        grant_date = date.fromisoformat(raw_grant.grantDate)
        award_name = raw_grant.awardName
        grant_name = raw_grant.grantName
        grant_number = raw_grant.grantNumber
        quantity = int(raw_grant.quantityGranted)
        expiration_str = raw_grant.expiredDate

        # Extract strike price from grant name (e.g. "02/05/2024 - ISO - $12.98")
        # Legacy/donation grants may not include a $ price — default to 0.0
        parts = grant_name.split("$")
        if len(parts) >= 2:
            strike_price = float(parts[-1].split()[0].rstrip(" -"))
        else:
            strike_price = 0.0
            log.warning("No strike price in grant name %r, defaulting to $0.00", grant_name)

        exercise_details = raw_grant.exerciseDetails
        vest_dates = exercise_details.vestDates
        parsed_vest_dates = [date.fromisoformat(d) for d in vest_dates]

        grant_type = determine_grant_type(award_name)
        vested_qty, vested_val = vested_by_instance.get(grant_name, (0, 0.0))
        expiration_date = date.fromisoformat(expiration_str) if expiration_str else None

        db.insert_option_grant(
            OptionGrant(
                id=grant_number,
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
        grant_count += 1
        log.info(
            "  Grant %s: %s %s, %d shares @ $%.2f, %d vested ($%.0f)",
            grant_number, grant_type, grant_date, quantity, strike_price,
            vested_qty, vested_val,
        )

    log.info("Morgan Stanley: parsed snapshot %s (%d grants)", timestamp, grant_count)
    return {"grants": grant_count}


def sync_morgan_stanley(
    db: Database,
    store: RawStore,
    profile: str,
) -> None:
    """Sync Morgan Stanley Shareworks stock option/RSU data."""
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")
    raw_key = f"morgan_stanley/{profile}/{timestamp}_portfolio_summary.json"

    try:
        from money.config import DATA_DIR

        # Load and merge all network log files
        log_dir = DATA_DIR / "network_logs"
        logs = sorted(log_dir.glob("morgan_stanley_*.json")) if log_dir.exists() else []
        if not logs:
            raise FileNotFoundError(
                "No Morgan Stanley network logs found. Visit Shareworks in Chrome."
            )

        all_entries: list[dict[str, Any]] = []
        for log_file in logs:
            file_data: dict[str, Any] = json.loads(log_file.read_text())
            all_entries.extend(file_data.get("entries", []))
        log.info("Loaded %d entries from %d network log files", len(all_entries), len(logs))

        # Extract portfolio summary and grants from captured responses
        summary_data: dict[str, Any] | None = None
        grants_data: dict[str, Any] | None = None

        for entry in all_entries:
            url: str = entry.get("url", "")
            body = entry.get("responseBody")
            if not isinstance(body, dict):
                continue
            if "portfolio/summary" in url and body.get("data"):
                summary_data = body
            elif url.endswith("/grants") and body.get("data"):
                grants_data = body

        if summary_data is None:
            raise ValueError(
                "No portfolio/summary response found in network log. "
                "Navigate to the Portfolio page on Shareworks."
            )
        if grants_data is None:
            raise ValueError(
                "No grants response found in network log. "
                "Navigate to the Grants page on Shareworks."
            )

        # Store in the format parse_raw_morgan_stanley expects
        store.put(raw_key, json.dumps(summary_data, indent=2).encode())
        store.put(
            f"morgan_stanley/{profile}/{timestamp}_grants.json",
            json.dumps(grants_data, indent=2).encode(),
        )

        summary: dict[str, Any] = summary_data.get("data", {})
        stock_price_str: str = summary.get("companyStockPrice", "0 USD")
        fmv_price_str: str = summary.get("valuedAtPrice", "0 USD")
        stock_price = parse_money(stock_price_str)
        fmv_price = parse_money(fmv_price_str)
        price_label: str = summary.get("marketPriceLabel", "")

        log.info(
            "Stock price: $%.2f, 409A FMV: $%.4f (label: %s)",
            stock_price, fmv_price, price_label,
        )

        # Parse and write to DB
        inst_dir = DATA_DIR / "raw" / "morgan_stanley" / (profile or "default")
        parse_raw_morgan_stanley(db, inst_dir, timestamp, profile)

        db.insert_ingestion_record(
            IngestionRecord(
                source="morgan_stanley",
                profile=profile,
                status=IngestionStatus.SUCCESS,
                raw_file_ref=raw_key,
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        # Clean up processed network logs
        for log_file in logs:
            log_file.unlink()
        log.info("Morgan Stanley sync complete (cleaned up %d network log files)", len(logs))

    except Exception as e:
        log.error("Morgan Stanley sync failed: %s", e)
        db.insert_ingestion_record(
            IngestionRecord(
                source="morgan_stanley",
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
    name="morgan_stanley",
    dir_name="morgan_stanley",
    sync_fn=sync_morgan_stanley,
    parse_fn=parse_raw_morgan_stanley,
    anchor_file="portfolio_summary.json",
    display_name="Morgan Stanley",
)