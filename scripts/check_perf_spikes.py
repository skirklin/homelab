"""Check performance data for spikes after forward-fill fix."""
import json
import urllib.request

data = json.loads(urllib.request.urlopen("http://127.0.0.1:5555/api/performance").read())
series = data["series"]
print(f"{len(series)} points")

# Aggregate by date like the chart does
by_date: dict[str, dict[str, float]] = {}
for p in series:
    d = p["date"]
    if d not in by_date:
        by_date[d] = {"balance": 0, "invested": 0}
    by_date[d]["balance"] += p["balance"]
    by_date[d]["invested"] += p["invested"] or 0

dates = sorted(by_date.keys())
print(f"{len(dates)} unique dates")

spike_count = 0
for i in range(1, len(dates)):
    prev_bal = by_date[dates[i - 1]]["balance"]
    cur_bal = by_date[dates[i]]["balance"]
    if prev_bal > 0:
        pct = abs(cur_bal - prev_bal) / prev_bal * 100
        if pct > 20:
            spike_count += 1
            if spike_count <= 10:
                print(f"  Spike: {dates[i-1]} -> {dates[i]}: "
                      f"${prev_bal:,.0f} -> ${cur_bal:,.0f} ({pct:.1f}%)")

if spike_count > 10:
    print(f"  ... and {spike_count - 10} more spikes")
elif spike_count == 0:
    print("No spikes detected!")

print(f"\nFirst: {dates[0]} ${by_date[dates[0]]['balance']:,.0f}")
print(f"Last: {dates[-1]} ${by_date[dates[-1]]['balance']:,.0f}")
