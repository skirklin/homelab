"""Inspect Wealthfront performance file structure."""

import json
from pathlib import Path

perf_files = sorted(Path(".data/raw/wealthfront").glob("*_performance.json"))
if not perf_files:
    print("No performance files")
    exit(1)

data = json.loads(perf_files[-1].read_text())
print(f"Top-level keys: {sorted(data.keys())}")

# Show first few entries of likely history arrays
for key in data:
    val = data[key]
    if isinstance(val, list) and len(val) > 0:
        print(f"\n{key}: {len(val)} items")
        print(f"  First: {json.dumps(val[0], indent=2)[:300]}")
        print(f"  Last:  {json.dumps(val[-1], indent=2)[:300]}")
    elif isinstance(val, dict):
        print(f"\n{key}: dict with keys {sorted(val.keys())[:10]}")
    else:
        print(f"\n{key}: {str(val)[:200]}")
