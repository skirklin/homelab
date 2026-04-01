"""Fidelity NetBenefits ingester — uses cookie relay + planSummary API.

Only the planSummary endpoint is accessible via cookie replay (other endpoints
are blocked by Akamai bot protection). This gives us monthly balance snapshots
and return percentages for the 401k plan.
"""

import logging
import urllib.request
from datetime import datetime
from pathlib import Path

from money.db import Database
from money.ingest.schemas import FidelityPlanSummaryResponse
from money.models import AccountType, Balance, IngestionRecord, IngestionStatus
from money.storage import RawStore

log = logging.getLogger(__name__)

# Plan identifiers embedded in the API path — captured from network traffic.
# If the user changes employers, these will need updating.
EMPLOYER_ID = "000789812"
PLAN_ID = "5504W"

PLAN_SUMMARY_URL = (
    f"https://workplaceservices.fidelity.com/mybenefits/dcsummary/api"
    f"/relationships/employer={EMPLOYER_ID};plan={PLAN_ID}/planSummary"
)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def _api_get(cookies: dict[str, str], url: str) -> bytes:
    """Make an authenticated GET request, return raw response bytes."""
    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
    req = urllib.request.Request(url)
    req.add_header("Cookie", cookie_str)
    req.add_header("Accept", "application/json, text/plain, */*")
    req.add_header("User-Agent", UA)

    resp = urllib.request.urlopen(req, timeout=30)
    return resp.read()


def sync_fidelity(
    db: Database, store: RawStore, profile: str, cookies: dict[str, str]
) -> None:
    """Sync Fidelity 401k balance and performance data."""
    started_at = datetime.now()
    timestamp = started_at.strftime("%Y%m%d_%H%M%S")

    try:
        log.info("Syncing Fidelity NetBenefits (profile: %s)", profile)

        raw_bytes = _api_get(cookies, PLAN_SUMMARY_URL)
        if raw_bytes.lstrip()[:1] != b"{":
            raise ValueError(
                "Fidelity returned HTML instead of JSON — cookies may be expired. "
                "Log into NetBenefits in Chrome to refresh."
            )
        raw_key = f"fidelity/{profile}/{timestamp}_planSummary.json"
        store.put(raw_key, raw_bytes)

        from money.config import DATA_DIR as _DATA_DIR

        inst_dir = _DATA_DIR / "raw" / "fidelity" / (profile or "default")
        result = parse_raw_fidelity(db, inst_dir, timestamp, profile)

        log.info(
            "Fidelity: %d balance(s), %d perf row(s)",
            result.get("balances", 0),
            result.get("performance_rows", 0),
        )

        db.insert_ingestion_record(
            IngestionRecord(
                source="fidelity",
                profile=profile,
                status=IngestionStatus.SUCCESS,
                raw_file_ref=raw_key,
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )

    except Exception as e:
        log.error("Fidelity sync failed: %s", e)
        db.insert_ingestion_record(
            IngestionRecord(
                source="fidelity",
                profile=profile,
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise


def parse_raw_fidelity(
    db: Database,
    inst_dir: Path,
    timestamp: str,
    profile: str | None,
) -> dict[str, int]:
    """Parse raw Fidelity planSummary JSON and write balances + performance to DB."""
    summary_path = inst_dir / f"{timestamp}_planSummary.json"
    data = FidelityPlanSummaryResponse.model_validate_json(summary_path.read_text())
    raw_key = f"fidelity/{profile}/{timestamp}_planSummary.json"

    # Single 401k account for this plan
    account = db.get_or_create_account(
        name="Fidelity 401(k)",
        account_type=AccountType.FOUR_OH_ONE_K,
        institution="fidelity",
        external_id=f"{EMPLOYER_ID}_{PLAN_ID}",
        profile=profile,
    )

    perf = data.performance
    months = perf.months

    # Insert balance snapshots from monthly fromBalance values.
    # fromBalance is the balance at the start of each month.
    balance_count = 0
    for month in months:
        month_date = datetime.fromisoformat(month.fromDate).date()
        db.insert_balance(
            Balance(
                account_id=account.id,
                as_of=month_date,
                balance=month.fromBalance,
                source="fidelity_plan_summary",
                raw_file_ref=raw_key,
            )
        )
        balance_count += 1

    # Also insert a current balance using the last month's end value.
    # end_balance ≈ fromBalance * (1 + returnValue/100)
    if months:
        last = months[-1]
        end_balance = last.fromBalance * (1 + last.returnValue / 100)
        end_date = datetime.fromisoformat(last.toDate).date()
        db.insert_balance(
            Balance(
                account_id=account.id,
                as_of=end_date,
                balance=round(end_balance, 2),
                source="fidelity_plan_summary",
                raw_file_ref=raw_key,
            )
        )
        balance_count += 1

    # Insert performance history rows (date, balance, invested=None, earned=None).
    # We don't have invested/earned breakdowns from this endpoint.
    perf_rows: list[tuple[str, str, float, float | None, float | None]] = []
    for month in months:
        month_date = datetime.fromisoformat(month.fromDate).date()
        perf_rows.append((
            account.id,
            month_date.isoformat(),
            month.fromBalance,
            None,
            None,
        ))
    if perf_rows:
        db.insert_performance_batch(perf_rows)

    return {"accounts": 1, "balances": balance_count, "performance_rows": len(perf_rows)}


from money.ingest.registry import InstitutionInfo  # noqa: E402

INSTITUTION = InstitutionInfo(
    name="fidelity",
    dir_name="fidelity",
    sync_fn=sync_fidelity,
    parse_fn=parse_raw_fidelity,
    anchor_file="planSummary.json",
    display_name="Fidelity NetBenefits",
)
