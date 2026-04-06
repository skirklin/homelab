"""Benchmark data and ETF metadata for investment analysis.

Provides:
- ETF ticker → asset class mapping
- Historical benchmark returns (S&P 500, total market, etc.)
- Time-weighted return calculations
"""

import json
import logging
import urllib.request
from datetime import date
from typing import Any

from money.config import DATA_DIR
from money.db import Database

log = logging.getLogger(__name__)

CACHE_DIR = DATA_DIR / "benchmarks"

# Standard ETF → asset class mapping.
# Covers Vanguard, iShares, Schwab, State Street funds commonly used by robo-advisors.
ETF_ASSET_CLASS: dict[str, str] = {
    # US Equities
    "VTI": "US Total Market",
    "VOO": "US Large Cap",
    "SPY": "US Large Cap",
    "IVV": "US Large Cap",
    "SPYM": "US Large Cap",
    "SCHB": "US Total Market",
    "SCHX": "US Large Cap",
    "VTV": "US Large Cap Value",
    "IVE": "US Large Cap Value",
    "VUG": "US Large Cap Growth",
    "IWF": "US Large Cap Growth",
    "VOE": "US Mid Cap Value",
    "IWS": "US Mid Cap Value",
    "VO": "US Mid Cap",
    "SPMD": "US Mid Cap",
    "VB": "US Small Cap",
    "VBR": "US Small Cap Value",
    "SPSM": "US Small Cap",
    "SCHA": "US Small Cap",
    "IWM": "US Small Cap",
    # International Equities
    "VEA": "International Developed",
    "SCHF": "International Developed",
    "SPDW": "International Developed",
    "EFA": "International Developed",
    "VWO": "International Emerging",
    "SPEM": "International Emerging",
    "IEMG": "International Emerging",
    "EEM": "International Emerging",
    # Bonds
    "BND": "US Total Bond",
    "AGG": "US Total Bond",
    "SCHZ": "US Total Bond",
    "MUB": "US Municipal Bond",
    "VTEB": "US Municipal Bond",
    "TFI": "US Municipal Bond",
    "BNDX": "International Bond",
    "EMB": "Emerging Market Bond",
    "VWOB": "Emerging Market Bond",
    "LQD": "US Corporate Bond",
    "VCIT": "US Corporate Bond",
    "SPIB": "US Corporate Bond",
    "TIP": "US TIPS",
    "VTIP": "US TIPS",
    "SHV": "US Short-Term Treasury",
    "SCHO": "US Short-Term Treasury",
    "BSV": "US Short-Term Bond",
    # Dividend / Factor ETFs
    "VIG": "US Large Cap",
    "DGRO": "US Large Cap",
    "SCHD": "US Large Cap",
    "VYM": "US Large Cap Value",
    "QUAL": "US Large Cap",
    # Extended market
    "VXF": "US Mid/Small Cap",
    # State / Muni bonds
    "CMF": "US Municipal Bond",
    "NYF": "US Municipal Bond",
    # TIPS
    "SCHP": "US TIPS",
    "STIP": "US Short-Term TIPS",
    # REITs
    "VNQ": "US REITs",
    "VNQI": "International REITs",
    # Commodities
    "GLD": "Gold",
    "IAU": "Gold",
    "GSG": "Commodities",
}

# Normalize the various asset class names from different institutions
# into a consistent two-level hierarchy: broad class / sub-class
ASSET_CLASS_NORMALIZE: dict[str, str] = {
    # US Equities
    "U.S. Large Cap Stocks": "US Equities / Large Cap",
    "US Large Cap": "US Equities / Large Cap",
    "US Large Cap (Direct Index)": "US Equities / Large Cap",
    "US Large-Cap": "US Equities / Large Cap",
    "US Total Market": "US Equities / Total Market",
    "US Large Cap Value": "US Equities / Large Cap Value",
    "US Large Cap Growth": "US Equities / Large Cap Growth",
    "U.S. Socially Responsible Stocks - Large Cap": "US Equities / Large Cap",
    "U.S. Quality Factor Stocks": "US Equities / Large Cap",
    "U.S. Engagement Stocks": "US Equities / Large Cap",
    "U.S. Mid Cap Stocks": "US Equities / Mid Cap",
    "US Mid Cap": "US Equities / Mid Cap",
    "US Mid Cap Value": "US Equities / Mid Cap",
    "US Mid/Small Cap": "US Equities / Mid Cap",
    "U.S. Small Cap Stocks": "US Equities / Small Cap",
    "US Small Cap": "US Equities / Small Cap",
    "US Small Cap Value": "US Equities / Small Cap",
    "U.S. Growth Stocks - Small Cap": "US Equities / Small Cap",
    "U.S. Socially Responsible Stocks - Small Cap": "US Equities / Small Cap",
    # International Equities
    "International Developed Market Stocks": "Int'l Equities / Developed",
    "International Developed": "Int'l Equities / Developed",
    "International Developed Market Stocks - Europe": "Int'l Equities / Developed",
    "International Developed Market Stocks - Japan": "Int'l Equities / Developed",
    "International Emerging Market Stocks": "Int'l Equities / Emerging",
    "International Emerging": "Int'l Equities / Emerging",
    "International Emerging Market Socially Responsible Stocks": "Int'l Equities / Emerging",
    # Bonds
    "U.S. High Quality Bonds": "Bonds / US Aggregate",
    "US Total Bond": "Bonds / US Aggregate",
    "U.S. Municipal Bonds": "Bonds / US Municipal",
    "US Municipal Bond": "Bonds / US Municipal",
    "Active Municipal Bonds": "Bonds / US Municipal",
    "International Bonds": "Bonds / International",
    "International Developed Market Bonds": "Bonds / International",
    "International Emerging Market Bonds": "Bonds / Emerging Market",
    "Emerging Market Bond": "Bonds / Emerging Market",
    "US Corporate Bond": "Bonds / US Corporate",
    "U.S. Investment-Grade Corporate Bonds": "Bonds / US Corporate",
    "U.S. Socially Responsible High Quality Bonds": "Bonds / US Aggregate",
    "US TIPS": "Bonds / TIPS",
    "US Short-Term TIPS": "Bonds / TIPS",
    "U.S. Inflation-Protected Bonds": "Bonds / TIPS",
    "U.S. Short-Term Treasury Bonds": "Bonds / US Treasury",
    "US Short-Term Treasury": "Bonds / US Treasury",
    "US Short-Term Bond": "Bonds / US Treasury",
    # Real Estate
    "US REITs": "Real Estate",
    "International REITs": "Real Estate",
    # Other
    "Gold": "Commodities",
    "Commodities": "Commodities",
}


def normalize_asset_class(raw: str) -> str:
    """Normalize an asset class name to a canonical two-level hierarchy."""
    return ASSET_CLASS_NORMALIZE.get(raw, raw)


# Broad benchmark tickers for comparison
BENCHMARKS = {
    "SPY": "S&P 500",
    "VTI": "US Total Market",
    "VEA": "Int'l Developed",
    "AGG": "US Bonds",
    "VT": "Global Total Market",
}


def get_asset_class(symbol: str) -> str | None:
    """Look up asset class for an ETF ticker symbol."""
    return ETF_ASSET_CLASS.get(symbol.upper())


def enrich_holdings_asset_classes(db: Database) -> int:
    """Update holdings rows that have NULL asset_class with known ETF classifications.

    For individual stocks (e.g. from Wealthfront direct indexing), classifies them
    as "US Large Cap (Direct Index)" since they are tax-loss harvesting substitutes
    for broad market ETFs.
    """
    count = 0

    # 1. Map known ETFs
    for symbol, asset_class in ETF_ASSET_CLASS.items():
        result = db.conn.execute(
            "UPDATE holdings SET asset_class = ? WHERE symbol = ? AND asset_class IS NULL",
            (asset_class, symbol),
        )
        count += result.rowcount

    # 2. Classify remaining Wealthfront holdings as direct-indexed US equities
    result = db.conn.execute(
        """UPDATE holdings SET asset_class = 'US Large Cap (Direct Index)'
           WHERE asset_class IS NULL
             AND account_id IN (
                 SELECT id FROM accounts WHERE institution = 'wealthfront'
             )""",
    )
    count += result.rowcount

    db.conn.commit()
    if count > 0:
        log.info("Enriched %d holdings with asset class data", count)
    return count


def fetch_yahoo_history(
    symbol: str,
    start: date | None = None,
    end: date | None = None,
) -> list[dict[str, Any]]:
    """Fetch daily price history from Yahoo Finance.

    Returns list of {date, close, adj_close} dicts.
    Uses a local cache to avoid repeated downloads.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    if start is None:
        start = date(2014, 1, 1)
    if end is None:
        end = date.today()

    cache_file = CACHE_DIR / f"{symbol}_{start}_{end}.json"
    if cache_file.exists():
        return list(json.loads(cache_file.read_text()))

    # Yahoo Finance v8 chart API
    period1 = int((start - date(1970, 1, 1)).total_seconds())
    period2 = int((end - date(1970, 1, 1)).total_seconds())
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?period1={period1}&period2={period2}&interval=1d"
        f"&includeAdjustedClose=true"
    )

    req = urllib.request.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0")

    log.info("Fetching %s history from Yahoo Finance (%s to %s)", symbol, start, end)
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())

    chart = data.get("chart", {}).get("result", [{}])[0]
    timestamps = chart.get("timestamp", [])
    quotes = chart.get("indicators", {}).get("quote", [{}])[0]
    adj_close = chart.get("indicators", {}).get("adjclose", [{}])[0].get("adjclose", [])
    closes = quotes.get("close", [])

    results: list[dict[str, Any]] = []
    for i, ts in enumerate(timestamps):
        d = date.fromtimestamp(ts)
        close = closes[i] if i < len(closes) else None
        adj = adj_close[i] if i < len(adj_close) else close
        if close is not None:
            results.append({
                "date": d.isoformat(),
                "close": round(close, 4),
                "adj_close": round(adj, 4) if adj else round(close, 4),
            })

    cache_file.write_text(json.dumps(results))
    log.info("Cached %d data points for %s", len(results), symbol)
    return results


def compute_twr(
    performance_data: list[dict[str, Any]],
) -> float:
    """Compute time-weighted return from performance history data.

    Each entry should have: date, balance, invested.
    TWR eliminates the effect of cash flows (deposits/withdrawals).
    """
    if len(performance_data) < 2:
        return 0.0

    cumulative = 1.0
    for i in range(1, len(performance_data)):
        prev = performance_data[i - 1]
        curr = performance_data[i]

        prev_balance = prev["balance"]
        curr_balance = curr["balance"]
        cash_flow = curr["invested"] - prev["invested"]

        if prev_balance + cash_flow == 0:
            continue

        period_return = (curr_balance - prev_balance - cash_flow) / (
            prev_balance + cash_flow
        )
        cumulative *= 1 + period_return

    return cumulative - 1
