"""Test Betterment performance history query to debug 500 errors."""

import json
import re
import urllib.request
import urllib.error
from pathlib import Path

from money.config import cookie_relay_path

# Load cookies
path = cookie_relay_path("betterment", "scott")
if not path.exists():
    path = cookie_relay_path("betterment")
data = json.loads(path.read_text())
cookies = {c["name"]: c["value"] for c in data.get("cookies", [])}
cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())

# Get CSRF token
req = urllib.request.Request("https://wwws.betterment.com/app")
req.add_header("Cookie", cookie_str)
req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0")
req.add_header("Accept", "text/html")
resp = urllib.request.urlopen(req)
html = resp.read().decode()
match = re.search(r'<meta\s+name="csrf-token"\s+content="([^"]+)"', html)
assert match, "No CSRF token found"
csrf = match.group(1)
print(f"Got CSRF token")

# Get the exact query from the network log
log_dir = Path(".data/network_logs")
logs = sorted(log_dir.glob("betterment_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
log_data = json.loads(logs[0].read_text())

for e in log_data["entries"]:
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

    print(f"\nFound captured query with variables: {json.dumps(parsed['variables'])}")
    acct_id = parsed["variables"]["id"]

    # Try with the EXACT captured query
    print("Trying with exact captured query...")
    payload = json.dumps(parsed).encode()
    req = urllib.request.Request(
        "https://wwws.betterment.com/api/graphql/web",
        data=payload, method="POST",
    )
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    req.add_header("Cookie", cookie_str)
    req.add_header("X-CSRF-Token", csrf)
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0")

    try:
        resp = urllib.request.urlopen(req)
        body = json.loads(resp.read())
        acct_data = body.get("data", {}).get("account", {})
        ts = acct_data.get("performanceHistory", {}).get("timeSeries", [])
        print(f"SUCCESS! Got {len(ts)} data points")
        if ts:
            print(f"  First: {ts[0]}")
            print(f"  Last: {ts[-1]}")
    except urllib.error.HTTPError as e:
        resp_body = e.read().decode()
        print(f"HTTP {e.code}: {resp_body[:300]}")

    break
