"""Check Ally network logs for any balance history or chart endpoints."""

import json
from pathlib import Path

log_dir = Path(".data/network_logs")
ally_logs = sorted(log_dir.glob("ally_*.json"), key=lambda p: p.stat().st_mtime)

for log_file in ally_logs:
    data = json.loads(log_file.read_text())
    entries = data["entries"]
    print(f"\n{log_file.name}: {len(entries)} entries")
    for e in entries:
        url: str = e.get("url", "")
        method = e.get("method", "")
        status = e.get("status", 0)
        size = e.get("responseSize") or 0
        ct: str = e.get("contentType", "")

        if not ("json" in ct or "/api/" in url or "/acs/" in url or "/capitan/" in url):
            continue

        base = url.split("?")[0]
        # Look for anything that might be history/chart/timeline
        keywords = ["history", "chart", "timeline", "trend", "balance", "statement",
                     "transaction", "activity"]
        interesting = any(k in base.lower() for k in keywords)
        marker = " <<<" if interesting else ""
        print(f"  {method:6s} {status:3d}  {size:>8,d} bytes  {base}{marker}")
