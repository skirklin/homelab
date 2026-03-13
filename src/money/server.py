"""Local HTTP server that receives scraped data from the Chrome extension."""

import json
import logging
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, cast

from money.config import cookie_relay_path
from money.db import Database
from money.models import AccountType, Balance, IngestionRecord, IngestionStatus
from money.storage import RawStore

log = logging.getLogger(__name__)

VALID_ACCOUNT_TYPES = {t.value for t in AccountType}


class IngestHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the extension data receiver."""

    db: Database
    store: RawStore

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json_response(200, {"status": "ok"})
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
        self._json_response(404, {"error": "not found"})

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
            result.append({
                "id": acct.id,
                "name": acct.name,
                "institution": acct.institution,
                "account_type": acct.account_type.value,
                "external_id": acct.external_id,
                "latest_balance": bal.balance if bal else None,
                "balance_as_of": bal.as_of.isoformat() if bal else None,
                "total_invested": perf["invested"] if perf else None,
                "total_earned": perf["earned"] if perf else None,
            })
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
            series.append({
                "account_id": row["account_id"],
                "account_name": row["name"],
                "institution": row["institution"],
                "date": row["as_of"],
                "balance": row["balance"],
            })
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
            account_data[aid].append((
                row["date"],
                row["balance"],
                row["invested"] or 0.0,
                row["earned"] or 0.0,
            ))

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
            series.append({
                "date": d,
                "net_worth": round(total_bal, 2),
                "invested": round(total_inv, 2),
                "earned": round(total_ear, 2),
            })
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
            account_data[aid].append((
                row["date"],
                row["balance"],
                row["invested"] or 0.0,
                row["earned"] or 0.0,
            ))

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
                    series.append({
                        "account_id": aid,
                        "account_name": meta["name"],
                        "institution": meta["institution"],
                        "account_type": meta["account_type"],
                        "date": d,
                        "balance": bal,
                        "invested": inv,
                        "earned": ear,
                    })
        self._json_response(200, {"series": series})

    def _handle_get_transactions(self) -> None:
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        account_id = params.get("account_id", [None])[0]
        search = params.get("search", [None])[0]
        start = params.get("start", [None])[0]
        end = params.get("end", [None])[0]
        limit = int(params.get("limit", ["200"])[0])

        query = """
            SELECT t.id, t.date, t.amount, t.description, t.category,
                   a.name as account_name, a.institution
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
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY t.date DESC, t.id DESC LIMIT ?"
        query_params.append(limit)

        rows = self.db.conn.execute(query, query_params).fetchall()
        transactions: list[dict[str, Any]] = []
        for row in rows:
            transactions.append({
                "id": row["id"],
                "date": row["date"],
                "amount": row["amount"],
                "description": row["description"],
                "category": row["category"],
                "account_name": row["account_name"],
                "institution": row["institution"],
            })
        self._json_response(200, {"transactions": transactions})

    def _handle_spending_summary(self) -> None:
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        group_by = params.get("group_by", ["month"])[0]

        if group_by == "category":
            rows = self.db.conn.execute("""
                SELECT COALESCE(t.category, t.description) as category,
                       SUM(t.amount) as total,
                       COUNT(*) as count
                FROM transactions t
                JOIN accounts a ON t.account_id = a.id
                WHERE a.account_type = 'checking' AND t.amount < 0
                GROUP BY category
                ORDER BY total ASC
            """).fetchall()
            categories: list[dict[str, Any]] = []
            for row in rows:
                categories.append({
                    "category": row["category"],
                    "total": row["total"],
                    "count": row["count"],
                })
            self._json_response(200, {"categories": categories})
        else:
            rows = self.db.conn.execute("""
                SELECT strftime('%Y-%m', t.date) as month,
                       SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as income,
                       SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END) as spending
                FROM transactions t
                JOIN accounts a ON t.account_id = a.id
                WHERE a.account_type = 'checking'
                GROUP BY month
                ORDER BY month ASC
            """).fetchall()
            months: list[dict[str, Any]] = []
            for row in rows:
                months.append({
                    "month": row["month"],
                    "income": row["income"],
                    "spending": row["spending"],
                    "net": row["income"] + row["spending"],
                })
            self._json_response(200, {"months": months})

    def do_POST(self) -> None:
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
        self._json_response(404, {"error": "not found"})

    def do_OPTIONS(self) -> None:
        """Handle CORS preflight requests from the extension."""
        self.send_response(204)
        self._set_cors_headers()
        self.end_headers()

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
        cookies_list = cast(list[dict[str, Any]], cookies_raw)

        profile = data.get("profile")
        path = cookie_relay_path(institution, profile)
        path.write_text(json.dumps(data, indent=2))
        label = f"{institution}/{profile}" if profile else institution
        log.info("Stored %d cookies for %s at %s", len(cookies_list), label, path)

        self._json_response(200, {
            "status": "ok",
            "institution": institution,
            "cookies_stored": len(cookies_list),
        })

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
        entries = cast(list[dict[str, Any]], entries_raw)

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

        self._json_response(200, {
            "status": "ok",
            "institution": institution,
            "entries_stored": len(entries),
            "api_routes_found": len(routes),
        })

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

        self._json_response(200, {
            "status": "ok",
            "institution": institution,
        })

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
        accounts_data = cast(list[dict[str, Any]], accounts_raw)

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


def run_server(
    db: Database,
    store: RawStore,
    port: int = 5555,
    host: str = "127.0.0.1",
) -> None:
    """Start the HTTP server to receive extension data."""
    # Attach db and store to the handler class so instances can access them
    IngestHandler.db = db
    IngestHandler.store = store

    server = HTTPServer((host, port), IngestHandler)
    log.info("Extension receiver listening on http://%s:%d", host, port)
    log.info("Press Ctrl+C to stop")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down server")
        server.shutdown()
