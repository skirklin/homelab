"""Backfill performance_history table from raw files and network logs."""

import base64
import json
import logging
from datetime import date
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

from money.db import Database

db = Database("money.db")
db.initialize()

total = 0

# --- Wealthfront ---
log.info("=== Wealthfront ===")
wf_perf_files = sorted(Path(".data/raw/wealthfront").glob("*_performance.json"))
if wf_perf_files:
    perf_data = json.loads(wf_perf_files[-1].read_text())
    history = perf_data.get("historyList", [])
    wf_account = db.get_account_by_external_id("wealthfront", "ACCB-4R4I-Z4ZQ-WNXN")
    if wf_account and history:
        rows: list[tuple[str, str, float, float | None, float | None]] = []
        for entry in history:
            mv = entry.get("marketValue")
            if mv is not None:
                invested = entry.get("sumNetDeposits")
                earned = (mv - invested) if invested is not None else None
                rows.append((
                    wf_account.id, entry["date"], float(mv),
                    float(invested) if invested is not None else None,
                    float(earned) if earned is not None else None,
                ))
        db.insert_performance_batch(rows)
        total += len(rows)
        log.info("Inserted %d Wealthfront points", len(rows))

# --- Betterment from network logs ---
log.info("\n=== Betterment ===")
log_dir = Path(".data/network_logs")
seen_accounts: set[str] = set()

for log_file in sorted(log_dir.glob("betterment_*.json"), key=lambda p: p.stat().st_mtime):
    data = json.loads(log_file.read_text())
    for e in data["entries"]:
        if "graphql" not in e.get("url", ""):
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
        acct_id = parsed.get("variables", {}).get("id", "")
        resp = e.get("responseBody")
        if not resp or acct_id in seen_accounts:
            continue
        seen_accounts.add(acct_id)

        try:
            decoded = base64.b64decode(acct_id).decode()
            external_id = decoded.split(":", 1)[1] if ":" in decoded else acct_id
        except Exception:
            external_id = acct_id

        account = db.get_account_by_external_id("betterment", external_id)
        if not account:
            continue

        if isinstance(resp, str):
            resp = json.loads(resp)
        ts = resp.get("data", {}).get("account", {}).get("performanceHistory", {}).get("timeSeries", [])

        rows = []
        for point in ts:
            bal = point.get("balance")
            if bal is not None:
                rows.append((
                    account.id, point["date"], bal / 100.0,
                    point.get("invested", 0) / 100.0 if point.get("invested") is not None else None,
                    point.get("earned", 0) / 100.0 if point.get("earned") is not None else None,
                ))
        db.insert_performance_batch(rows)
        total += len(rows)
        log.info("  %s: %d points", account.name, len(rows))

# --- Betterment from raw performance files ---
perf_files = sorted(Path(".data/raw/betterment").glob("*_performance.json"))
for pf in perf_files:
    data = json.loads(pf.read_text())
    acct_data = data.get("data", {}).get("account", {})
    ts = acct_data.get("performanceHistory", {}).get("timeSeries", [])
    if not ts:
        continue
    # Extract external_id from the account id in the data
    gql_id = acct_data.get("id", "")
    try:
        decoded = base64.b64decode(gql_id).decode()
        external_id = decoded.split(":", 1)[1] if ":" in decoded else gql_id
    except Exception:
        external_id = gql_id
    if external_id in seen_accounts:
        continue
    seen_accounts.add(external_id)

    account = db.get_account_by_external_id("betterment", external_id)
    if not account:
        continue

    rows = []
    for point in ts:
        bal = point.get("balance")
        if bal is not None:
            rows.append((
                account.id, point["date"], bal / 100.0,
                point.get("invested", 0) / 100.0 if point.get("invested") is not None else None,
                point.get("earned", 0) / 100.0 if point.get("earned") is not None else None,
            ))
    db.insert_performance_batch(rows)
    total += len(rows)
    log.info("  %s (raw file): %d points", account.name, len(rows))

db.close()
log.info("\nDone. Total: %d performance records", total)
