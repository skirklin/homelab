"""Extract specific Betterment GraphQL operations for ingester development."""

import json
from pathlib import Path

log_dir = Path(".data/network_logs")
files = sorted(log_dir.glob("betterment_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)

if not files:
    print("No betterment network logs found")
    exit(1)

data = json.loads(files[0].read_text())
entries = data["entries"]

target_ops = [
    "SidebarAccounts",
    "PurposeHeader",
    "EnvelopeAccountPerformanceHistory",
    "PerformanceAccounts",
]

found: set[str] = set()
for e in entries:
    url: str = e.get("url", "")
    if "graphql" not in url:
        continue
    req_body = e.get("requestBody")
    if not req_body:
        continue
    try:
        parsed = json.loads(req_body)
    except json.JSONDecodeError:
        continue
    op = parsed.get("operationName", "")
    if op not in target_ops or op in found:
        continue
    found.add(op)

    print(f"=== {op} ===")
    print(f"Variables: {json.dumps(parsed.get('variables', {}), indent=2)}")
    print("Query:")
    print(parsed.get("query", ""))
    resp = e.get("responseBody")
    if resp:
        preview = json.dumps(resp, indent=2)[:2000]
        print("Response preview:")
        print(preview)
    print()
