"""Local HTTP server that receives scraped data from the Chrome extension."""

import json
import logging
import threading
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from money.db import Database
from money.models import AccountType, Balance, IngestionRecord, IngestionStatus
from money.storage import RawStore

log = logging.getLogger(__name__)

# Track in-flight syncs to avoid duplicates
_active_syncs: set[str] = set()
_sync_lock = threading.Lock()

VALID_ACCOUNT_TYPES = {t.value for t in AccountType}


class IngestHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the extension data receiver."""

    db_path: str
    store: RawStore

    @property
    def db(self) -> Database:
        """Get a per-request DB connection (cached on the instance)."""
        if not hasattr(self, '_db'):
            self._db = Database(self.db_path)
            self._db.initialize()
        return self._db

    def _close_db(self) -> None:
        if hasattr(self, '_db'):
            self._db.close()
            del self._db

    def do_GET(self) -> None:
        try:
            self._do_GET()
        finally:
            self._close_db()

    def _do_GET(self) -> None:
        if self.path == "/health":
            self._json_response(200, {"status": "ok"})
            return
        if self.path.startswith("/api/last-sync"):
            self._handle_last_sync()
            return
        if self.path == "/api/accounts":
            self._handle_get_accounts()
            return
        if self.path.startswith("/api/balances"):
            self._handle_get_balances()
            return
        if self.path.startswith("/api/net-worth/history"):
            self._handle_net_worth_history()
            return
        if self.path.startswith("/api/performance"):
            self._handle_performance()
            return
        if self.path.startswith("/api/transactions"):
            self._handle_get_transactions()
            return
        if self.path.startswith("/api/spending/summary"):
            self._handle_spending_summary()
            return
        if self.path.startswith("/api/holdings"):
            self._handle_get_holdings()
            return
        if self.path.startswith("/api/grants"):
            self._handle_grants()
            return
        if self.path.startswith("/api/sync-status"):
            self._handle_sync_status()
            return
        if self.path.startswith("/api/allocation"):
            self._handle_allocation()
            return
        if self.path.startswith("/api/benchmarks"):
            self._handle_benchmarks()
            return
        if self.path.startswith("/api/net-worth/summary"):
            self._handle_net_worth_summary()
            return
        if self.path.startswith("/api/travel/trips"):
            self._handle_travel_trips()
            return
        if self.path.startswith("/api/suggestions"):
            self._handle_get_suggestions()
            return
        if self.path.startswith("/api/recurring"):
            self._handle_get_recurring()
            return
        self._json_response(404, {"error": "not found"})

    def _handle_last_sync(self) -> None:
        """Return the most recent transaction/balance date per institution."""
        from urllib.parse import parse_qs, urlparse

        params = parse_qs(urlparse(self.path).query)
        institution = params.get("institution", [None])[0]

        if not institution:
            self._json_response(400, {"error": "missing 'institution' parameter"})
            return

        row = self.db.conn.execute(
            """SELECT MAX(t.date) as last_transaction, MAX(b.as_of) as last_balance
               FROM accounts a
               LEFT JOIN transactions t ON t.account_id = a.id
               LEFT JOIN balances b ON b.account_id = a.id
               WHERE a.institution = ?""",
            (institution,),
        ).fetchone()

        self._json_response(200, {
            "institution": institution,
            "last_transaction": row["last_transaction"] if row else None,
            "last_balance": row["last_balance"] if row else None,
        })

    def _handle_get_accounts(self) -> None:
        accounts = self.db.list_accounts()
        result: list[dict[str, Any]] = []
        for acct in accounts:
            bal = self.db.get_latest_balance(acct.id, date.today())
            # Get latest performance data (invested/earned)
            perf = self.db.conn.execute(
                """SELECT invested, earned FROM performance_history
                   WHERE account_id = ? ORDER BY date DESC LIMIT 1""",
                (acct.id,),
            ).fetchone()
            result.append(
                {
                    "id": acct.id,
                    "name": acct.name,
                    "institution": acct.institution,
                    "account_type": acct.account_type.value,
                    "external_id": acct.external_id,
                    "latest_balance": bal.balance if bal else None,
                    "balance_as_of": bal.as_of.isoformat() if bal else None,
                    "total_invested": perf["invested"] if perf else None,
                    "total_earned": perf["earned"] if perf else None,
                }
            )
        self._json_response(200, {"accounts": result})

    def _handle_get_balances(self) -> None:
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        account_id = params.get("account_id", [None])[0]

        query = """
            SELECT b.account_id, a.name, a.institution, b.as_of, b.balance
            FROM balances b
            JOIN accounts a ON b.account_id = a.id
        """
        query_params: list[str] = []
        if account_id:
            query += " WHERE b.account_id = ?"
            query_params.append(account_id)
        query += " ORDER BY b.as_of ASC, a.name ASC"

        rows = self.db.conn.execute(query, query_params).fetchall()
        series: list[dict[str, Any]] = []
        for row in rows:
            series.append(
                {
                    "account_id": row["account_id"],
                    "account_name": row["name"],
                    "institution": row["institution"],
                    "date": row["as_of"],
                    "balance": row["balance"],
                }
            )
        self._json_response(200, {"balances": series})

    def _handle_net_worth_history(self) -> None:
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        start = params.get("start", [None])[0]
        end = params.get("end", [None])[0]

        # Get all performance data per account
        query = """
            SELECT p.account_id, p.date, p.balance, p.invested, p.earned
            FROM performance_history p
            ORDER BY p.account_id, p.date ASC
        """
        rows = self.db.conn.execute(query).fetchall()

        # Build per-account time series
        account_data: dict[str, list[tuple[str, float, float, float]]] = {}
        for row in rows:
            aid = row["account_id"]
            if aid not in account_data:
                account_data[aid] = []
            account_data[aid].append(
                (
                    row["date"],
                    row["balance"],
                    row["invested"] or 0.0,
                    row["earned"] or 0.0,
                )
            )

        # Collect all unique dates and forward-fill each account
        all_dates: set[str] = set()
        for points in account_data.values():
            for d, _, _, _ in points:
                all_dates.add(d)
        sorted_dates = sorted(all_dates)

        if start:
            sorted_dates = [d for d in sorted_dates if d >= start]
        if end:
            sorted_dates = [d for d in sorted_dates if d <= end]

        # For each account, build a lookup and forward-fill
        account_series: dict[str, dict[str, tuple[float, float, float]]] = {}
        for aid, points in account_data.items():
            lookup: dict[str, tuple[float, float, float]] = {}
            for d, bal, inv, ear in points:
                lookup[d] = (bal, inv, ear)
            account_series[aid] = lookup

        series: list[dict[str, Any]] = []
        last_known: dict[str, tuple[float, float, float]] = {}
        for d in sorted_dates:
            total_bal = 0.0
            total_inv = 0.0
            total_ear = 0.0
            for aid in account_data:
                if d in account_series[aid]:
                    last_known[aid] = account_series[aid][d]
                if aid in last_known:
                    bal, inv, ear = last_known[aid]
                    total_bal += bal
                    total_inv += inv
                    total_ear += ear
            series.append(
                {
                    "date": d,
                    "net_worth": round(total_bal, 2),
                    "invested": round(total_inv, 2),
                    "earned": round(total_ear, 2),
                }
            )
        self._json_response(200, {"series": series})

    def _handle_performance(self) -> None:
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        account_id = params.get("account_id", [None])[0]
        institution = params.get("institution", [None])[0]
        start = params.get("start", [None])[0]
        end = params.get("end", [None])[0]

        query = """
            SELECT p.account_id, a.name, a.institution, a.account_type,
                   p.date, p.balance, p.invested, p.earned
            FROM performance_history p
            JOIN accounts a ON p.account_id = a.id
        """
        conditions: list[str] = []
        query_params: list[str] = []
        if account_id:
            conditions.append("p.account_id = ?")
            query_params.append(account_id)
        if institution:
            conditions.append("a.institution = ?")
            query_params.append(institution)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY p.account_id, p.date ASC"

        rows = self.db.conn.execute(query, query_params).fetchall()

        # Build per-account data and metadata
        account_meta: dict[str, dict[str, str]] = {}
        account_data: dict[str, list[tuple[str, float, float, float]]] = {}
        for row in rows:
            aid = row["account_id"]
            if aid not in account_meta:
                account_meta[aid] = {
                    "name": row["name"],
                    "institution": row["institution"],
                    "account_type": row["account_type"],
                }
                account_data[aid] = []
            account_data[aid].append(
                (
                    row["date"],
                    row["balance"],
                    row["invested"] or 0.0,
                    row["earned"] or 0.0,
                )
            )

        # Collect all dates and apply forward-fill (LOCF)
        all_dates: set[str] = set()
        account_series: dict[str, dict[str, tuple[float, float, float]]] = {}
        for aid, points in account_data.items():
            lookup: dict[str, tuple[float, float, float]] = {}
            for d, bal, inv, ear in points:
                all_dates.add(d)
                lookup[d] = (bal, inv, ear)
            account_series[aid] = lookup

        sorted_dates = sorted(all_dates)
        if start:
            sorted_dates = [d for d in sorted_dates if d >= start]
        if end:
            sorted_dates = [d for d in sorted_dates if d <= end]

        series: list[dict[str, Any]] = []
        last_known: dict[str, tuple[float, float, float]] = {}
        for d in sorted_dates:
            for aid in account_data:
                if d in account_series[aid]:
                    last_known[aid] = account_series[aid][d]
                if aid in last_known:
                    bal, inv, ear = last_known[aid]
                    meta = account_meta[aid]
                    series.append(
                        {
                            "account_id": aid,
                            "account_name": meta["name"],
                            "institution": meta["institution"],
                            "account_type": meta["account_type"],
                            "date": d,
                            "balance": bal,
                            "invested": inv,
                            "earned": ear,
                        }
                    )
        self._json_response(200, {"series": series})

    def _handle_get_transactions(self) -> None:
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        account_id = params.get("account_id", [None])[0]
        search = params.get("search", [None])[0]
        start = params.get("start", [None])[0]
        end = params.get("end", [None])[0]
        hide_transfers = params.get("hide_transfers", ["0"])[0] == "1"
        limit = int(params.get("limit", ["200"])[0])

        query = """
            SELECT t.id, t.date, t.amount, t.description, t.category,
                   t.category_path, a.name as account_name, a.institution
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
        """
        conditions: list[str] = []
        query_params: list[str | int] = []
        if account_id:
            conditions.append("t.account_id = ?")
            query_params.append(account_id)
        if search:
            conditions.append("t.description LIKE ?")
            query_params.append(f"%{search}%")
        if start:
            conditions.append("t.date >= ?")
            query_params.append(start)
        if end:
            conditions.append("t.date <= ?")
            query_params.append(end)
        if hide_transfers:
            # Exclude transactions that have a matching opposite-amount entry
            # on the same date in a different account (inter-account transfers)
            conditions.append("""
                t.id NOT IN (
                    SELECT t1.id FROM transactions t1
                    JOIN transactions t2 ON t1.date = t2.date
                        AND t1.account_id != t2.account_id
                        AND ABS(t1.amount + t2.amount) < 0.01
                )
            """)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY t.date DESC, t.id DESC LIMIT ?"
        query_params.append(limit)

        rows = self.db.conn.execute(query, query_params).fetchall()
        transactions: list[dict[str, Any]] = []
        for row in rows:
            transactions.append(
                {
                    "id": row["id"],
                    "date": row["date"],
                    "amount": row["amount"],
                    "description": row["description"],
                    "category": row["category"],
                    "category_path": row["category_path"],
                    "account_name": row["account_name"],
                    "institution": row["institution"],
                }
            )
        self._json_response(200, {"transactions": transactions})

    def _handle_sync_status(self) -> None:
        """Return per-login freshness status."""
        from money.config import load_config

        config = load_config()

        # Get freshness data per profile (login_id) from DB
        rows = self.db.conn.execute("""
            SELECT a.profile,
                   a.institution,
                   MAX(b.as_of) as last_balance,
                   MAX(t.date) as last_transaction,
                   COUNT(DISTINCT a.id) as account_count
            FROM accounts a
            LEFT JOIN balances b ON b.account_id = a.id
            LEFT JOIN transactions t ON t.account_id = a.id
            WHERE a.institution IS NOT NULL
            GROUP BY a.profile, a.institution
        """).fetchall()

        # Keyed by (profile, institution) — profile may be None for legacy rows
        db_data: dict[tuple[str | None, str], dict[str, Any]] = {}
        for row in rows:
            key = (row["profile"], row["institution"])
            db_data[key] = {
                "last_balance": row["last_balance"],
                "last_transaction": row["last_transaction"],
                "account_count": row["account_count"],
            }

        statuses: list[dict[str, Any]] = []
        for login_id, login_config in config.logins.items():
            inst_id = login_config.institution
            inst_config = config.institutions.get(inst_id)

            # Match by profile first, fall back to institution-only match
            data = (
                db_data.get((login_id, inst_id))
                or db_data.get((None, inst_id))
                or {}
            )
            last_balance = data.get("last_balance")
            last_txn = data.get("last_transaction")
            freshest = max(last_balance or "", last_txn or "")
            days_stale = (
                (date.today() - date.fromisoformat(freshest)).days
                if freshest else None
            )

            person_config = config.people.get(login_config.person)
            person_name = person_config.name if person_config else login_config.person
            inst_label = (inst_config.label if inst_config else inst_id) or inst_id
            url = inst_config.url if inst_config else None

            statuses.append({
                "login_id": login_id,
                "institution": inst_id,
                "person": login_config.person,
                "person_name": person_name,
                "label": f"{inst_label} ({person_name})",
                "url": url,
                "account_count": data.get("account_count", 0),
                "last_balance_date": last_balance,
                "last_transaction_date": last_txn,
                "days_stale": days_stale,
                "is_stale": days_stale is not None and days_stale > 3,
            })

        self._json_response(200, {"statuses": statuses})

    def _handle_grants(self) -> None:
        """Return stock option/RSU grants with vested data from Morgan Stanley."""
        from money.db import row_to_option_grant

        fmv_row = self.db.conn.execute(
            "SELECT fmv_per_share FROM private_valuations ORDER BY as_of DESC LIMIT 1"
        ).fetchone()
        fmv = float(fmv_row[0]) if fmv_row else 0.0

        rows = self.db.conn.execute(
            "SELECT * FROM option_grants ORDER BY grant_date"
        ).fetchall()

        result: list[dict[str, Any]] = []
        for row in rows:
            grant = row_to_option_grant(row)
            per_share = max(0.0, fmv - grant.strike_price)

            # Tax rates: NQ/RSU taxed as ordinary income (~50%), ISO as LTCG (~35%)
            tax_rate = 0.35 if grant.grant_type == "ISO" else 0.50
            after_tax_vested = grant.vested_value * (1 - tax_rate)

            result.append({
                "id": grant.id,
                "type": grant.grant_type,
                "grant_date": grant.grant_date.isoformat(),
                "total_shares": grant.total_shares,
                "vested_shares": grant.vested_shares,
                "unvested_shares": grant.total_shares - grant.vested_shares,
                "strike_price": grant.strike_price,
                "fmv": fmv,
                "per_share_value": per_share,
                "vested_value": grant.vested_value,
                "after_tax_vested_value": after_tax_vested,
                "tax_rate": tax_rate,
                "unvested_value": grant.total_shares * per_share - grant.vested_value,
                "total_value": grant.total_shares * per_share,
                "expiration_date": (
                    grant.expiration_date.isoformat() if grant.expiration_date else None
                ),
                "pct_vested": (
                    round(grant.vested_shares / grant.total_shares * 100, 1)
                    if grant.total_shares > 0 else 0
                ),
                "vest_dates": [d.isoformat() for d in grant.vest_dates],
            })

        total_after_tax = sum(g["after_tax_vested_value"] for g in result)

        self._json_response(200, {
            "grants": result,
            "fmv_per_share": fmv,
            "total_vested_value": sum(g["vested_value"] for g in result),
            "total_after_tax_vested_value": total_after_tax,
            "total_unvested_value": sum(g["unvested_value"] for g in result),
            "total_value": sum(g["total_value"] for g in result),
        })

    def _handle_allocation(self) -> None:
        """Return asset allocation breakdown across all investment accounts."""
        from money.benchmarks import normalize_asset_class

        rows = self.db.conn.execute("""
            SELECT COALESCE(h.asset_class, 'Unclassified') as asset_class,
                   SUM(h.value) as total_value,
                   COUNT(*) as position_count,
                   a.institution
            FROM holdings h
            JOIN accounts a ON h.account_id = a.id
            WHERE h.as_of = (SELECT MAX(h2.as_of) FROM holdings h2
                             WHERE h2.account_id = h.account_id)
              AND h.value > 0.01
            GROUP BY asset_class, a.institution
            ORDER BY total_value DESC
        """).fetchall()

        # Normalize asset classes and aggregate
        by_class: dict[str, float] = {}
        by_class_inst: dict[str, dict[str, float]] = {}
        for row in rows:
            normalized = normalize_asset_class(row["asset_class"])
            inst = row["institution"]
            val = float(row["total_value"])

            by_class[normalized] = by_class.get(normalized, 0.0) + val
            if normalized not in by_class_inst:
                by_class_inst[normalized] = {}
            by_class_inst[normalized][inst] = (
                by_class_inst[normalized].get(inst, 0.0) + val
            )

        # Split into broad class (before /) and sub-class (after /)
        summary = []
        for cls, val in sorted(by_class.items(), key=lambda x: -x[1]):
            parts = cls.split(" / ", 1)
            summary.append({
                "asset_class": cls,
                "broad_class": parts[0],
                "sub_class": parts[1] if len(parts) > 1 else None,
                "value": val,
                "by_institution": by_class_inst.get(cls, {}),
            })

        self._json_response(200, {"allocation": summary})

    def _handle_benchmarks(self) -> None:
        """Return benchmark price history for comparison charts."""
        from urllib.parse import parse_qs, urlparse

        from money.benchmarks import BENCHMARKS, fetch_yahoo_history

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        symbols = params.get("symbols", list(BENCHMARKS.keys()))
        start_str = params.get("start", [None])[0]
        end_str = params.get("end", [None])[0]

        start = date.fromisoformat(start_str) if start_str else None
        end = date.fromisoformat(end_str) if end_str else None

        result: dict[str, Any] = {}
        for symbol in symbols:
            if isinstance(symbol, str):
                data = fetch_yahoo_history(symbol.upper(), start, end)
                result[symbol.upper()] = {
                    "name": BENCHMARKS.get(symbol.upper(), symbol.upper()),
                    "data": data,
                }

        self._json_response(200, {"benchmarks": result})

    def _handle_net_worth_summary(self) -> None:
        """Return net worth broken into liquid, +vested equity, +all equity."""
        # Liquid net worth: all accounts except stock_options
        liquid_row = self.db.conn.execute("""
            SELECT COALESCE(SUM(b.balance), 0)
            FROM balances b
            JOIN accounts a ON b.account_id = a.id
            WHERE a.account_type != 'stock_options'
              AND b.as_of = (SELECT MAX(b2.as_of) FROM balances b2
                             WHERE b2.account_id = b.account_id)
        """).fetchone()
        liquid = float(liquid_row[0]) if liquid_row else 0.0

        # Get FMV
        fmv_row = self.db.conn.execute(
            "SELECT fmv_per_share FROM private_valuations ORDER BY as_of DESC LIMIT 1"
        ).fetchone()
        fmv = float(fmv_row[0]) if fmv_row else 0.0

        # Vested and total equity from stored grant data
        equity_row = self.db.conn.execute("""
            SELECT COALESCE(SUM(vested_value), 0),
                   COALESCE(SUM(total_shares * (? - strike_price)), 0)
            FROM option_grants
            WHERE (? - strike_price) > 0
        """, (fmv, fmv)).fetchone()
        vested_value = float(equity_row[0])
        total_equity_value = float(equity_row[1])

        # After-tax vested: apply ~50% for NQ/RSU, ~35% for ISO
        after_tax_row = self.db.conn.execute("""
            SELECT COALESCE(SUM(
                CASE WHEN grant_type = 'ISO' THEN vested_value * 0.65
                     ELSE vested_value * 0.50
                END
            ), 0)
            FROM option_grants
        """).fetchone()
        after_tax_vested = float(after_tax_row[0])

        self._json_response(200, {
            "liquid": liquid,
            "liquid_plus_vested": liquid + vested_value,
            "liquid_plus_vested_after_tax": liquid + after_tax_vested,
            "liquid_plus_all_equity": liquid + total_equity_value,
            "vested_equity": vested_value,
            "after_tax_vested_equity": after_tax_vested,
            "total_equity": total_equity_value,
            "fmv_per_share": fmv,
        })

    def _handle_get_holdings(self) -> None:
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        account_id = params.get("account_id", [None])[0]
        institution = params.get("institution", [None])[0]

        query = """
            SELECT h.symbol, h.name, h.asset_class, h.shares, h.value,
                   h.as_of, a.name as account_name, a.institution
            FROM holdings h
            JOIN accounts a ON h.account_id = a.id
            WHERE h.as_of = (
                SELECT MAX(h2.as_of) FROM holdings h2
                WHERE h2.account_id = h.account_id
            )
        """
        conditions: list[str] = []
        query_params: list[str] = []
        if account_id:
            conditions.append("h.account_id = ?")
            query_params.append(account_id)
        if institution:
            conditions.append("a.institution = ?")
            query_params.append(institution)
        if conditions:
            query += " AND " + " AND ".join(conditions)
        query += " ORDER BY a.name, h.value DESC"

        rows = self.db.conn.execute(query, query_params).fetchall()
        holdings: list[dict[str, Any]] = []
        for row in rows:
            holdings.append(
                {
                    "symbol": row["symbol"],
                    "name": row["name"],
                    "asset_class": row["asset_class"],
                    "shares": row["shares"],
                    "value": row["value"],
                    "as_of": row["as_of"],
                    "account_name": row["account_name"],
                    "institution": row["institution"],
                }
            )
        self._json_response(200, {"holdings": holdings})

    def _handle_spending_summary(self) -> None:
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        group_by = params.get("group_by", ["month"])[0]
        start = params.get("start", [None])[0]
        end = params.get("end", [None])[0]

        # Use category_path for grouping; exclude Capital top-level group.
        date_filter = "AND t.date >= date('now', '-1 year')"
        date_params: list[str] = []
        if start and end:
            date_filter = "AND t.date >= ? AND t.date <= ?"
            date_params = [start, end]
        elif start:
            date_filter = "AND t.date >= ?"
            date_params = [start]
        elif end:
            date_filter = "AND t.date <= ?"
            date_params = [end]

        base_cte = f"""
            WITH base AS (
                SELECT t.id, t.date, t.amount, t.description, t.category,
                       t.category_path
                FROM transactions t
                JOIN accounts a ON t.account_id = a.id
                WHERE a.account_type IN ('checking', 'credit_card')
                  {date_filter}
                  AND (t.category_path IS NULL
                       OR t.category_path NOT LIKE 'capital%')
            )
        """

        if group_by == "category":
            # Group by next path segment under parent (or top-level if no parent)
            parent = params.get("parent", [None])[0]

            if parent:
                parent_prefix = f"{parent}/"
                parent_len = len(parent_prefix)
                rows = self.db.conn.execute(f"""
                    {base_cte}
                    SELECT CASE
                             WHEN b.category_path = ? THEN ?
                             WHEN b.category_path LIKE ? THEN
                               CASE INSTR(SUBSTR(b.category_path, ?), '/')
                                 WHEN 0 THEN SUBSTR(b.category_path, ?)
                                 ELSE SUBSTR(b.category_path, ?,
                                             INSTR(SUBSTR(b.category_path, ?), '/') - 1)
                               END
                             ELSE 'Other'
                           END as cat,
                           SUM(b.amount) as total,
                           COUNT(*) as count
                    FROM base b
                    WHERE b.amount < 0
                      AND (b.category_path = ? OR b.category_path LIKE ?)
                    GROUP BY cat
                    ORDER BY total ASC
                """, [
                    *date_params,
                    parent, parent,
                    parent_prefix + "%",
                    parent_len + 1, parent_len + 1,
                    parent_len + 1, parent_len + 1,
                    parent, parent_prefix + "%",
                ]).fetchall()
            else:
                rows = self.db.conn.execute(f"""
                    {base_cte}
                    SELECT CASE
                             WHEN b.category_path IS NULL THEN 'uncategorized'
                             WHEN INSTR(b.category_path, '/') = 0 THEN b.category_path
                             ELSE SUBSTR(b.category_path, 1,
                                         INSTR(b.category_path, '/') - 1)
                           END as cat,
                           SUM(b.amount) as total,
                           COUNT(*) as count
                    FROM base b
                    WHERE b.amount < 0
                    GROUP BY cat
                    ORDER BY total ASC
                """, date_params).fetchall()

            categories: list[dict[str, Any]] = []
            for row in rows:
                categories.append(
                    {
                        "category": row["cat"],
                        "total": row["total"],
                        "count": row["count"],
                    }
                )
            self._json_response(200, {"categories": categories})

        elif group_by == "subcategory":
            # Group by full category_path (for drill-down into a top-level group)
            parent = params.get("parent", [None])[0]
            parent_filter = ""
            extra_params: list[str] = []
            if parent == "Uncategorized":
                parent_filter = "AND b.category_path IS NULL"
            elif parent:
                parent_filter = (
                    "AND (b.category_path = ? OR b.category_path LIKE ?)"
                )
                extra_params = [parent, f"{parent}/%"]

            rows = self.db.conn.execute(f"""
                {base_cte}
                SELECT COALESCE(b.category_path, b.description, 'Unknown') as cat,
                       SUM(b.amount) as total,
                       COUNT(*) as count
                FROM base b
                WHERE b.amount < 0
                  {parent_filter}
                GROUP BY cat
                ORDER BY total ASC
            """, [*date_params, *extra_params]).fetchall()
            categories = []
            for row in rows:
                categories.append(
                    {
                        "category": row["cat"],
                        "total": row["total"],
                        "count": row["count"],
                    }
                )
            self._json_response(200, {"categories": categories})

        elif group_by == "month_category":
            # Spending by month × category for stacked charts.
            # When parent is set, drill into subcategories within that parent.
            top_n = int(params.get("top", ["10"])[0])
            parent = params.get("parent", [None])[0]

            if parent:
                # Drill-down: show subcategories within the parent
                parent_prefix = f"{parent}/"
                parent_len = len(parent_prefix)

                # Extract the next path segment after the parent prefix
                # e.g. "Housing/Utilities" with parent="Housing" → "Utilities"
                cat_expr = """
                    CASE
                      WHEN b.category_path = ? THEN ?
                      WHEN b.category_path LIKE ? THEN
                        CASE INSTR(SUBSTR(b.category_path, ?), '/')
                          WHEN 0 THEN SUBSTR(b.category_path, ?)
                          ELSE SUBSTR(b.category_path, ?,
                                      INSTR(SUBSTR(b.category_path, ?), '/') - 1)
                        END
                      ELSE 'Other'
                    END
                """
                cat_params = [
                    parent, parent,
                    parent_prefix + "%",
                    parent_len + 1, parent_len + 1,
                    parent_len + 1, parent_len + 1,
                ]

                rows = self.db.conn.execute(f"""
                    {base_cte}
                    SELECT strftime('%Y-%m', b.date) as month,
                           {cat_expr} as cat,
                           SUM(b.amount) as total
                    FROM base b
                    WHERE b.amount < 0
                      AND (b.category_path = ? OR b.category_path LIKE ?)
                    GROUP BY month, cat
                    ORDER BY month ASC
                """, [*date_params, *cat_params, parent, parent_prefix + "%"]).fetchall()
            else:
                # Top-level view
                top_cat_expr = """
                    CASE INSTR(b.category_path, '/')
                      WHEN 0 THEN COALESCE(b.category_path, 'Uncategorized')
                      ELSE SUBSTR(b.category_path, 1, INSTR(b.category_path, '/') - 1)
                    END
                """

                top_rows = self.db.conn.execute(f"""
                    {base_cte}
                    SELECT {top_cat_expr} as cat,
                           SUM(b.amount) as total
                    FROM base b
                    WHERE b.amount < 0
                    GROUP BY cat
                    ORDER BY total ASC
                    LIMIT ?
                """, [*date_params, top_n]).fetchall()
                top_cats = [row["cat"] for row in top_rows]

                cat_placeholders = ",".join("?" for _ in top_cats)
                rows = self.db.conn.execute(f"""
                    {base_cte}
                    SELECT strftime('%Y-%m', b.date) as month,
                           CASE
                             WHEN {top_cat_expr} IN ({cat_placeholders})
                             THEN {top_cat_expr}
                             ELSE 'Other'
                           END as cat,
                           SUM(b.amount) as total
                    FROM base b
                    WHERE b.amount < 0
                    GROUP BY month, cat
                    ORDER BY month ASC
                """, [*date_params, *top_cats]).fetchall()

            months_map: dict[str, dict[str, float]] = {}
            all_cats: set[str] = set()
            for row in rows:
                month: str = row["month"]
                cat: str = row["cat"]
                all_cats.add(cat)
                if month not in months_map:
                    months_map[month] = {"month": month}  # type: ignore[dict-item]
                months_map[month][cat] = abs(row["total"])

            result: list[dict[str, Any]] = []
            for m in sorted(months_map):
                entry = months_map[m]
                for cat in all_cats:
                    entry.setdefault(cat, 0.0)
                result.append(entry)

            self._json_response(200, {
                "months": result,
                "categories": sorted(all_cats, key=lambda c: c != "Other"),
            })

        else:
            # Default: monthly income/spending totals
            rows = self.db.conn.execute(f"""
                {base_cte}
                SELECT strftime('%Y-%m', b.date) as month,
                       SUM(CASE WHEN b.amount > 0 THEN b.amount ELSE 0 END) as income,
                       SUM(CASE WHEN b.amount < 0 THEN b.amount ELSE 0 END) as spending
                FROM base b
                GROUP BY month
                ORDER BY month ASC
            """, date_params).fetchall()
            months_list: list[dict[str, Any]] = []
            for row in rows:
                months_list.append(
                    {
                        "month": row["month"],
                        "income": row["income"],
                        "spending": row["spending"],
                        "net": row["income"] + row["spending"],
                    }
                )
            self._json_response(200, {"months": months_list})

    def _handle_travel_trips(self) -> None:
        """Return travel spending grouped by trip, using calendar data."""
        from money.calendar import detect_trips, match_transactions_to_trips

        trips = detect_trips()

        rows = self.db.conn.execute("""
            SELECT t.date, t.amount, t.description, t.category, a.name as account_name
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            WHERE (t.category_path = 'travel' OR t.category_path LIKE 'travel/%')
              AND t.date >= date('now', '-1 year')
            ORDER BY t.date
        """).fetchall()

        transactions = [
            {
                "date": row["date"],
                "amount": row["amount"],
                "description": row["description"],
                "category": row["category"],
                "account_name": row["account_name"],
            }
            for row in rows
        ]

        grouped = match_transactions_to_trips(trips, transactions)

        trip_summaries: list[dict[str, Any]] = []
        trip_lookup = {f"{t['name']} ({t['start'][:7]})": t for t in trips}
        for key, txns in grouped.items():
            if key == "Other Travel":
                continue
            trip = trip_lookup.get(key, {})
            total = sum(t["amount"] for t in txns)
            trip_summaries.append(
                {
                    "name": trip.get("name", key),
                    "start": trip.get("start"),
                    "end": trip.get("end"),
                    "duration_days": trip.get("duration_days"),
                    "location": trip.get("location"),
                    "total": total,
                    "transaction_count": len(txns),
                    "transactions": txns,
                }
            )

        trip_summaries.sort(key=lambda t: t.get("start") or "")

        other_txns = grouped.get("Other Travel", [])
        if other_txns:
            total = sum(t["amount"] for t in other_txns)
            trip_summaries.append(
                {
                    "name": "Other Travel",
                    "start": None,
                    "end": None,
                    "duration_days": None,
                    "location": None,
                    "total": total,
                    "transaction_count": len(other_txns),
                    "transactions": other_txns,
                }
            )

        self._json_response(200, {"trips": trip_summaries})

    def _handle_collection_summary(self, collection: str, group_by: str) -> None:
        """Return spending summary filtered to a top-level category group."""
        path_filter = "(t.category_path = ? OR t.category_path LIKE ?)"
        path_params = [collection, f"{collection}/%"]

        if group_by == "category":
            rows = self.db.conn.execute(
                f"""
                SELECT COALESCE(t.category_path, t.description) as cat,
                       SUM(t.amount) as total,
                       COUNT(*) as count
                FROM transactions t
                WHERE {path_filter}
                GROUP BY cat
                ORDER BY total ASC
            """,
                path_params,
            ).fetchall()
            categories: list[dict[str, Any]] = []
            for row in rows:
                categories.append(
                    {
                        "category": row["cat"],
                        "total": row["total"],
                        "count": row["count"],
                    }
                )
            self._json_response(200, {"categories": categories})
        else:
            rows = self.db.conn.execute(
                f"""
                SELECT strftime('%Y-%m', t.date) as month,
                       SUM(t.amount) as total,
                       COUNT(*) as count
                FROM transactions t
                WHERE {path_filter}
                GROUP BY month
                ORDER BY month ASC
            """,
                path_params,
            ).fetchall()
            months: list[dict[str, Any]] = []
            for row in rows:
                months.append(
                    {
                        "month": row["month"],
                        "total": row["total"],
                        "count": row["count"],
                    }
                )
            self._json_response(200, {"months": months})

    def _handle_get_recurring(self) -> None:
        from money.recurring import get_recurring_patterns

        patterns = get_recurring_patterns(self.db)

        self._json_response(200, {"patterns": patterns})

    def _handle_recurring_action(self) -> None:
        from money.recurring import confirm_pattern, dismiss_pattern

        parts = self.path.rstrip("/").split("/")
        if len(parts) < 4:
            self._json_response(400, {"error": "invalid path"})
            return
        action = parts[-1]
        try:
            pattern_id = int(parts[-2])
        except ValueError:
            self._json_response(400, {"error": "invalid pattern id"})
            return

        if action == "confirm":
            confirm_pattern(self.db, pattern_id)
            self._json_response(200, {"confirmed": True})
        elif action == "dismiss":
            dismiss_pattern(self.db, pattern_id)
            self._json_response(200, {"dismissed": True})
        else:
            self._json_response(400, {"error": f"unknown action: {action}"})

    def _handle_get_suggestions(self) -> None:
        from money.suggest import get_pending_suggestions

        suggestions = get_pending_suggestions(self.db)
        self._json_response(200, {"suggestions": suggestions})

    def _handle_suggestion_action(self) -> None:
        """Handle POST /api/suggestions/{id}/accept or /reject."""
        from money.suggest import accept_suggestion, reject_suggestion

        parts = self.path.rstrip("/").split("/")
        if len(parts) < 4:
            self._json_response(400, {"error": "invalid path"})
            return

        action = parts[-1]
        try:
            rule_id = int(parts[-2])
        except ValueError:
            self._json_response(400, {"error": "invalid rule id"})
            return

        if action == "accept":
            count = accept_suggestion(self.db, rule_id)
            self._json_response(200, {"accepted": True, "categorized": count})
        elif action == "reject":
            content_length = int(self.headers.get("Content-Length", 0))
            feedback = None
            if content_length > 0:
                body = json.loads(self.rfile.read(content_length))
                if isinstance(body, dict):
                    feedback = body.get("feedback")
            reject_suggestion(self.db, rule_id, feedback)
            self._json_response(200, {"rejected": True})
        else:
            self._json_response(400, {"error": f"unknown action: {action}"})

    def _handle_generate_suggestions(self) -> None:
        """Trigger AI suggestion generation (async-friendly)."""
        import threading

        from money.suggest import generate_suggestions

        content_length = int(self.headers.get("Content-Length", 0))
        body: dict[str, Any] = {}
        if content_length > 0:
            raw = json.loads(self.rfile.read(content_length))
            if isinstance(raw, dict):
                body = raw

        transaction_id = body.get("transaction_id")
        feedback = body.get("feedback")

        db_path = self.db.path

        def _run() -> None:
            try:
                thread_db = Database(db_path)
                thread_db.initialize()
                try:
                    if transaction_id and feedback:
                        from money.suggest import reclassify_transaction
                        reclassify_transaction(
                            thread_db, int(transaction_id), str(feedback),
                        )
                    else:
                        generate_suggestions(thread_db)
                finally:
                    thread_db.close()
            except Exception:
                log.exception("Suggestion generation failed")

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()
        self._json_response(202, {"status": "generating"})

    def do_POST(self) -> None:
        try:
            self._do_POST()
        finally:
            self._close_db()

    def _do_POST(self) -> None:
        if self.path == "/ingest":
            self._handle_ingest()
            return
        if self.path == "/cookies":
            self._handle_cookies()
            return
        if self.path == "/network-log":
            self._handle_network_log()
            return
        if self.path == "/auth-token":
            self._handle_auth_token()
            return
        if self.path == "/trigger-sync":
            self._handle_trigger_sync()
            return
        if self.path == "/api/suggestions/generate" or self.path == "/api/suggestions/reclassify":
            self._handle_generate_suggestions()
            return
        if self.path.startswith("/api/recurring/"):
            self._handle_recurring_action()
            return
        if self.path.startswith("/api/suggestions/"):
            self._handle_suggestion_action()
            return
        self._json_response(404, {"error": "not found"})

    def do_OPTIONS(self) -> None:
        """Handle CORS preflight requests from the extension."""
        self.send_response(204)
        self._set_cors_headers()
        self.end_headers()

    def _resolve_login_id(self, institution: str) -> str | None:
        """Look up the login_id for an institution from config."""
        from money.config import load_config

        try:
            config = load_config()
            for lid, lc in config.logins.items():
                if lc.institution == institution:
                    return lid
        except Exception:
            pass
        return None

    def _trigger_auto_sync(
        self,
        institution: str,
        login_id: str | None,
        cookies: dict[str, str] | None = None,
    ) -> None:
        """Kick off a background sync for an institution."""
        thread = threading.Thread(
            target=_run_auto_sync,
            args=(self.db.path, self.store, institution, login_id),
            kwargs={"cookies": cookies},
            daemon=True,
        )
        thread.start()

    def _handle_cookies(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._json_response(400, {"error": "empty request body"})
            return

        try:
            data = json.loads(self.rfile.read(content_length))
        except json.JSONDecodeError as e:
            self._json_response(400, {"error": f"invalid JSON: {e}"})
            return

        institution = data.get("institution")
        if not institution or not isinstance(institution, str):
            self._json_response(400, {"error": "missing or invalid 'institution' field"})
            return

        cookies_raw = data.get("cookies", [])
        if not isinstance(cookies_raw, list):
            self._json_response(400, {"error": "'cookies' must be a list"})
            return

        from money.config import DATA_DIR

        login_id = self._resolve_login_id(institution)

        # Persist cookies for CLI use
        cookies_dir = DATA_DIR / "cookies"
        cookies_dir.mkdir(parents=True, exist_ok=True)
        persist_key = login_id or institution
        persist_path = cookies_dir / f"{persist_key}.json"
        persist_path.write_text(json.dumps(data, indent=2))
        log.info(
            "Stored %d cookies for %s at %s", len(cookies_raw), institution, persist_path,
        )

        # Convert cookie list to dict and pass directly to sync
        cookies_dict: dict[str, str] = {c["name"]: c["value"] for c in cookies_raw}
        self._trigger_auto_sync(institution, login_id, cookies=cookies_dict)

        self._json_response(
            200,
            {
                "status": "ok",
                "institution": institution,
                "cookies_stored": len(cookies_raw),
            },
        )

    def _handle_network_log(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._json_response(400, {"error": "empty request body"})
            return

        try:
            data = json.loads(self.rfile.read(content_length))
        except json.JSONDecodeError as e:
            self._json_response(400, {"error": f"invalid JSON: {e}"})
            return

        institution = data.get("institution")
        if not institution or not isinstance(institution, str):
            self._json_response(400, {"error": "missing or invalid 'institution' field"})
            return

        entries_raw = data.get("entries", [])
        if not isinstance(entries_raw, list):
            self._json_response(400, {"error": "'entries' must be a list"})
            return
        entries: list[dict[str, Any]] = list(entries_raw)

        from money.config import DATA_DIR

        log_dir = DATA_DIR / "network_logs"
        log_dir.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = log_dir / f"{institution}_{timestamp}.json"
        path.write_text(json.dumps(data, indent=2))
        log.info("Stored %d network log entries for %s at %s", len(entries), institution, path)

        # Print a summary of unique API routes
        routes: set[str] = set()
        for entry in entries:
            url: str = entry.get("url", "")
            method: str = entry.get("method", "GET")
            content_type: str = entry.get("contentType", "")
            if "json" in content_type or "/api/" in url or "/capitan/" in url:
                routes.add(f"{method} {url}")
        if routes:
            log.info("API routes discovered for %s:", institution)
            for route in sorted(routes):
                log.info("  %s", route)

        login_id = self._resolve_login_id(institution)
        self._trigger_auto_sync(institution, login_id)

        self._json_response(
            200,
            {
                "status": "ok",
                "institution": institution,
                "entries_stored": len(entries),
                "api_routes_found": len(routes),
            },
        )

    def _handle_trigger_sync(self) -> None:
        """Handle a sync trigger from the extension (e.g. Ally needs Playwright)."""
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._json_response(400, {"error": "empty request body"})
            return

        try:
            data = json.loads(self.rfile.read(content_length))
        except json.JSONDecodeError as e:
            self._json_response(400, {"error": f"invalid JSON: {e}"})
            return

        institution = data.get("institution")
        if not institution:
            self._json_response(400, {"error": "missing 'institution'"})
            return

        login_id = self._resolve_login_id(institution)
        log.info("Sync triggered for %s (login: %s)", institution, login_id)

        self._trigger_playwright_sync(institution, login_id)

        self._json_response(200, {"status": "ok", "institution": institution, "login_id": login_id})

    def _trigger_playwright_sync(self, institution: str, login_id: str | None) -> None:
        """Run a Playwright-based sync in a background thread."""
        thread = threading.Thread(
            target=_run_playwright_sync,
            args=(self.db.path, self.store, institution, login_id),
            daemon=True,
        )
        thread.start()

    def _handle_auth_token(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._json_response(400, {"error": "empty request body"})
            return

        try:
            data = json.loads(self.rfile.read(content_length))
        except json.JSONDecodeError as e:
            self._json_response(400, {"error": f"invalid JSON: {e}"})
            return

        institution = data.get("institution")
        if not institution or not isinstance(institution, str):
            self._json_response(400, {"error": "missing or invalid 'institution' field"})
            return

        from money.config import DATA_DIR

        token_dir = DATA_DIR / "auth_tokens"
        token_dir.mkdir(parents=True, exist_ok=True)

        path = token_dir / f"{institution}.json"
        path.write_text(json.dumps(data, indent=2))
        log.info("Stored auth token for %s (expires in %ss)", institution, data.get("expiresIn"))

        self._json_response(
            200,
            {
                "status": "ok",
                "institution": institution,
            },
        )

    def _handle_ingest(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._json_response(400, {"error": "empty request body"})
            return

        raw_body = self.rfile.read(content_length)

        try:
            data = json.loads(raw_body)
        except json.JSONDecodeError as e:
            self._json_response(400, {"error": f"invalid JSON: {e}"})
            return

        institution = data.get("institution")
        if not institution or not isinstance(institution, str):
            self._json_response(400, {"error": "missing or invalid 'institution' field"})
            return

        accounts_raw = data.get("accounts", [])
        if not isinstance(accounts_raw, list):
            self._json_response(400, {"error": "'accounts' must be a list"})
            return
        accounts_data: list[dict[str, Any]] = list(accounts_raw)

        started_at = datetime.now()
        timestamp = started_at.strftime("%Y%m%d_%H%M%S")

        try:
            result = _process_ingest(
                db=self.db,
                store=self.store,
                institution=institution,
                accounts_data=accounts_data,
                raw_body=raw_body,
                timestamp=timestamp,
                started_at=started_at,
            )
            self._json_response(200, result)

        except Exception as e:
            log.exception("Ingest failed for %s", institution)
            self.db.insert_ingestion_record(
                IngestionRecord(
                    source=f"{institution}_extension",
                    status=IngestionStatus.ERROR,
                    error_message=str(e),
                    started_at=started_at,
                    finished_at=datetime.now(),
                )
            )
            self._json_response(500, {"error": str(e)})

    def _json_response(self, status: int, body: dict[str, Any]) -> None:
        response = json.dumps(body).encode()
        self.send_response(status)
        self._set_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def _set_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format: str, *args: object) -> None:
        log.info(format, *args)


def _resolve_account_type(raw_type: str) -> AccountType:
    """Convert a string account type to an AccountType enum value."""
    if raw_type in VALID_ACCOUNT_TYPES:
        return AccountType(raw_type)
    # Try common mappings
    mapping: dict[str, AccountType] = {
        "investment": AccountType.BROKERAGE,
        "brokerage": AccountType.BROKERAGE,
        "ira": AccountType.IRA,
        "401k": AccountType.FOUR_OH_ONE_K,
        "checking": AccountType.CHECKING,
        "savings": AccountType.SAVINGS,
        "credit_card": AccountType.CREDIT_CARD,
    }
    return mapping.get(raw_type.lower(), AccountType.CHECKING)


def _process_ingest(
    db: Database,
    store: RawStore,
    institution: str,
    accounts_data: list[dict[str, Any]],
    raw_body: bytes,
    timestamp: str,
    started_at: datetime,
) -> dict[str, Any]:
    """Process incoming extension data: store raw, upsert accounts, record balances."""

    # Store the raw payload
    raw_key = f"{institution}/extension_{timestamp}.json"
    store.put(raw_key, raw_body)
    log.info("Stored raw payload: %s", raw_key)

    accounts_synced = 0
    balances_recorded = 0

    for acct_data in accounts_data:
        name = acct_data.get("name", "").strip()
        external_id = acct_data.get("external_id", "").strip()
        raw_type = acct_data.get("account_type", "checking")
        balance_val = acct_data.get("balance")

        if not name or not external_id:
            log.warning("Skipping account with missing name or external_id: %s", acct_data)
            continue

        account_type = _resolve_account_type(raw_type)

        account = db.get_or_create_account(
            name=name,
            account_type=account_type,
            institution=institution,
            external_id=external_id,
        )
        accounts_synced += 1
        log.info("Synced account: %s ••%s [%s]", name, external_id, account_type.value)

        if balance_val is not None:
            try:
                balance_float = float(balance_val)
            except (ValueError, TypeError):
                log.warning("Invalid balance value for %s: %r", name, balance_val)
                continue

            db.insert_balance(
                Balance(
                    account_id=account.id,
                    as_of=date.today(),
                    balance=balance_float,
                    source=f"{institution}_extension",
                    raw_file_ref=raw_key,
                )
            )
            balances_recorded += 1
            log.info("  Balance: $%,.2f", balance_float)

    db.insert_ingestion_record(
        IngestionRecord(
            source=f"{institution}_extension",
            status=IngestionStatus.SUCCESS,
            raw_file_ref=raw_key,
            started_at=started_at,
            finished_at=datetime.now(),
        )
    )

    return {
        "status": "ok",
        "accounts_synced": accounts_synced,
        "balances_recorded": balances_recorded,
        "raw_file_ref": raw_key,
    }


def _run_playwright_sync(
    db_path: str,
    store: RawStore,
    institution: str,
    login_id: str | None,
) -> None:
    """Run a Playwright-based sync (e.g. Ally) in the background."""
    sync_key = login_id or institution

    with _sync_lock:
        if sync_key in _active_syncs:
            log.info("Sync already in progress for %s, skipping", sync_key)
            return
        _active_syncs.add(sync_key)

    db = Database(db_path, check_same_thread=False)
    try:
        db.initialize()
        log.info("Playwright sync starting for %s (login: %s)", institution, login_id)

        from money.ingest.scrapers.ally import login_ally

        profile = login_id or institution
        token, cookies_dict = login_ally(profile, headless=True)
        cookies_dict["Ally-CIAM-Token"] = token

        from money.ingest.ally_api import sync_ally_api

        sync_ally_api(db, store, profile=profile, cookies=cookies_dict)

        from money.benchmarks import enrich_holdings_asset_classes
        from money.categorize import apply_rules

        enrich_holdings_asset_classes(db)
        apply_rules(db)

        log.info("Playwright sync complete for %s (login: %s)", institution, login_id)

    except Exception:
        log.exception("Playwright sync failed for %s (login: %s)", institution, login_id)
    finally:
        with _sync_lock:
            _active_syncs.discard(sync_key)
        db.close()


def _run_auto_sync(
    db_path: str,
    store: RawStore,
    institution: str,
    login_id: str | None = None,
    cookies: dict[str, str] | None = None,
) -> None:
    """Run a sync for an institution in the background after receiving fresh auth data."""
    sync_key = login_id or institution

    with _sync_lock:
        if sync_key in _active_syncs:
            log.info("Sync already in progress for %s, skipping", sync_key)
            return
        _active_syncs.add(sync_key)

    db = Database(db_path, check_same_thread=False)
    try:
        db.initialize()
        log.info("Auto-sync starting for %s (login: %s)", institution, login_id)

        from money.ingest.registry import get as get_institution

        try:
            inst = get_institution(institution)
        except KeyError:
            log.info("No auto-sync configured for %s", institution)
            return

        if inst.playwright_sync:
            log.info("Skipping auto-sync for %s (requires Playwright)", institution)
            return

        # Cookie-based institutions get cookies passed through;
        # network-log institutions (chase, morgan_stanley) don't use cookies.
        if cookies is not None:
            inst.sync_fn(db, store, profile=login_id, cookies=cookies)
        else:
            inst.sync_fn(db, store, profile=login_id)

        # Enrich and recategorize after sync
        from money.benchmarks import enrich_holdings_asset_classes
        from money.categorize import apply_rules
        enrich_holdings_asset_classes(db)
        apply_rules(db)

        log.info("Auto-sync complete for %s (login: %s)", institution, login_id)

    except Exception:
        log.exception("Auto-sync failed for %s (login: %s)", institution, login_id)
    finally:
        with _sync_lock:
            _active_syncs.discard(sync_key)
        db.close()


def run_server(
    db: Database,
    store: RawStore,
    port: int = 5555,
    host: str = "0.0.0.0",
) -> None:
    """Start the HTTP server to receive extension data."""
    # Store path and store on the handler class; each request gets its own DB connection
    IngestHandler.db_path = db.path
    IngestHandler.store = store
    db.close()  # Close the setup connection; requests will create their own

    server = ThreadingHTTPServer((host, port), IngestHandler)
    log.info("Extension receiver listening on http://%s:%d", host, port)
    log.info("Press Ctrl+C to stop")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down server")
        server.shutdown()
