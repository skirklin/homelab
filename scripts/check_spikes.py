"""Check net worth history for spikes."""
import json
import urllib.request

data = json.loads(urllib.request.urlopen("http://127.0.0.1:5555/api/net-worth/history").read())
series = data["series"]
print(f"{len(series)} points")

for i in range(1, len(series)):
    prev, cur = series[i - 1]["net_worth"], series[i]["net_worth"]
    if prev > 0:
        pct = abs(cur - prev) / prev * 100
        if pct > 20:
            print(f"  Spike: {series[i-1]['date']} -> {series[i]['date']}: "
                  f"${prev:,.0f} -> ${cur:,.0f} ({pct:.1f}%)")

print(f"First: {series[0]['date']} ${series[0]['net_worth']:,.0f}")
print(f"Last: {series[-1]['date']} ${series[-1]['net_worth']:,.0f}")
