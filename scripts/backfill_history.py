"""Backfill historical daily balances from network logs and raw performance files."""

import base64
import json
import logging
from datetime import date
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

from money.db import Database
from money.models import Balance

db = Database("money.db")
db.initialize()

inserted = 0


def insert_balance(account_id: str, as_of: date, balance: float, source: str) -> None:
    global inserted
    db.insert_balance(
        Balance(account_id=account_id, as_of=as_of, balance=balance, source=source)
    )
    inserted += 1


# --- Wealthfront: performance files have daily historyList ---
log.info("=== Wealthfront ===")
wf_perf_files = sorted(Path(".data/raw/wealthfront").glob("*_performance.json"))
if wf_perf_files:
    perf_file = wf_perf_files[-1]
    log.info("Using %s", perf_file.name)
    perf_data = json.loads(perf_file.read_text())
    history = perf_data.get("historyList", [])

    wf_account = db.get_account_by_external_id("wealthfront", "ACCB-4R4I-Z4ZQ-WNXN")
    if wf_account:
        before = inserted
        for entry in history:
            d = date.fromisoformat(entry["date"])
            val = entry.get("marketValue")
            if val is not None:
                insert_balance(wf_account.id, d, float(val), "wealthfront_performance")
        log.info("Inserted %d Wealthfront history points", inserted - before)
    else:
        log.warning("Wealthfront account not found in DB")
else:
    log.info("No Wealthfront performance files found")

# --- Betterment: extract from ALL network logs ---
log.info("\n=== Betterment ===")
log_dir = Path(".data/network_logs")
bmt_logs = sorted(log_dir.glob("betterment_*.json"), key=lambda p: p.stat().st_mtime)

# Collect all unique performance responses across all logs
seen_accounts: set[str] = set()
all_perf_ops: list[dict] = []

for log_file in bmt_logs:
    data = json.loads(log_file.read_text())
    for e in data["entries"]:
        url = e.get("url", "")
        if "graphql" not in url:
            continue
        req_body = e.get("requestBody")
        if not req_body:
            continue
        try:
            parsed = json.loads(req_body)
        except json.JSONDecodeError:
            continue
        if parsed.get("operationName") != "EnvelopeAccountPerformanceHistory":
            continue
        resp = e.get("responseBody")
        acct_id = parsed.get("variables", {}).get("id", "")
        if resp and acct_id and acct_id not in seen_accounts:
            seen_accounts.add(acct_id)
            all_perf_ops.append({"variables": parsed["variables"], "response": resp})

log.info("Found %d unique account performance histories across %d log files",
         len(all_perf_ops), len(bmt_logs))

for op in all_perf_ops:
    acct_graphql_id = op["variables"].get("id", "")
    try:
        decoded = base64.b64decode(acct_graphql_id).decode()
        external_id = decoded.split(":", 1)[1] if ":" in decoded else acct_graphql_id
    except Exception:
        external_id = acct_graphql_id

    account = db.get_account_by_external_id("betterment", external_id)
    if not account:
        log.warning("  No DB account for external_id=%s, skipping", external_id[:12])
        continue

    resp_data = op["response"]
    if isinstance(resp_data, str):
        resp_data = json.loads(resp_data)

    acct_data = resp_data.get("data", {}).get("account", {})
    time_series = acct_data.get("performanceHistory", {}).get("timeSeries", [])

    before = inserted
    for point in time_series:
        bal_cents = point.get("balance")
        if bal_cents is not None:
            insert_balance(
                account.id, date.fromisoformat(point["date"]),
                bal_cents / 100.0, "betterment_performance",
            )
    log.info("  %s: %d points inserted", account.name, inserted - before)

db.close()
log.info("\nDone. Total inserted: %d balance records", inserted)
