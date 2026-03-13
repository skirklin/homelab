"""Extract all GraphQL operations from captured Betterment network logs."""

import json
from pathlib import Path

log_dir = Path(".data/network_logs")
files = sorted(log_dir.glob("betterment_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)

if not files:
    print("No betterment network logs found")
    exit(1)

data = json.loads(files[0].read_text())
entries = data["entries"]

print(f"File: {files[0].name}")
print(f"Total entries: {len(entries)}\n")

graphql_ops: list[dict] = []
for e in entries:
    url = e.get("url", "")
    if "graphql" not in url:
        continue
    req_body = e.get("requestBody")
    resp_body = e.get("responseBody")
    if not req_body:
        continue

    try:
        parsed = json.loads(req_body)
    except json.JSONDecodeError:
        continue

    op_name = parsed.get("operationName", "unknown")
    query = parsed.get("query", "")
    variables = parsed.get("variables", {})

    graphql_ops.append({
        "operation": op_name,
        "query": query,
        "variables": variables,
        "response": resp_body,
        "status": e.get("status"),
        "size": e.get("responseSize", 0),
    })

print(f"Found {len(graphql_ops)} GraphQL operations:\n")

seen: set[str] = set()
for op in graphql_ops:
    name = op["operation"]
    if name in seen:
        continue
    seen.add(name)

    print(f"{'=' * 60}")
    print(f"  Operation: {name}")
    print(f"  Status: {op['status']}  Response size: {op['size'] or 0:,d} bytes")
    if op["variables"]:
        print(f"  Variables: {json.dumps(op['variables'])}")
    print(f"  Query:")
    for line in op["query"].splitlines():
        print(f"    {line}")

    if op["response"]:
        preview = json.dumps(op["response"], indent=2)[:600]
        print(f"  Response:")
        for line in preview.splitlines():
            print(f"    {line}")
        if len(json.dumps(op["response"], indent=2)) > 600:
            print(f"    ... ({len(json.dumps(op['response'], indent=2)):,d} total chars)")
    print()
