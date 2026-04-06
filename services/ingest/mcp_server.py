"""MCP server exposing the money database to Claude Code and Claude Desktop."""

import json
import sqlite3
from datetime import date

from mcp.server.fastmcp import FastMCP

from money.config import DB_PATH

mcp = FastMCP(
    "money",
    instructions=(
        "Personal finance database. Contains accounts, balances, transactions, holdings, "
        "performance history, option grants, and private valuations across multiple financial "
        "institutions. Balances are positive for assets, negative amounts on liability accounts "
        "(credit cards) represent money owed. The 'is_liability' flag on accounts indicates "
        "liabilities. Performance history tracks invested vs earned for investment accounts. "
        "Transactions have hierarchical category_path like 'Food/Groceries' or 'Travel/Lodging'."
    ),
)


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, object]]:
    return [dict(r) for r in rows]



# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@mcp.tool()
def list_accounts() -> str:
    """List all financial accounts with their latest balance and basic info.

    Returns account name, institution, type, whether it's a liability, and latest balance.
    """
    conn = _get_conn()
    rows = conn.execute("""
        SELECT a.id, a.name, COALESCE(a.display_name, a.name) AS display_name,
               a.institution, a.account_type, a.is_liability, a.profile,
               b.balance AS latest_balance, b.as_of AS balance_date
        FROM accounts a
        LEFT JOIN balances b ON b.account_id = a.id
            AND b.as_of = (SELECT MAX(b2.as_of) FROM balances b2 WHERE b2.account_id = a.id)
        ORDER BY a.institution, a.name
    """).fetchall()
    conn.close()
    return json.dumps(_rows_to_dicts(rows), indent=2)


@mcp.tool()
def get_net_worth() -> str:
    """Get current net worth: total assets minus total liabilities.

    Also breaks down by institution and shows the as-of date for each account's balance.
    """
    conn = _get_conn()
    rows = conn.execute("""
        SELECT a.institution,
               COALESCE(a.display_name, a.name) AS account_name,
               a.account_type, a.is_liability,
               b.balance, b.as_of
        FROM accounts a
        JOIN balances b ON b.account_id = a.id
            AND b.as_of = (SELECT MAX(b2.as_of) FROM balances b2 WHERE b2.account_id = a.id)
        ORDER BY a.institution, a.name
    """).fetchall()
    conn.close()

    total_assets = 0.0
    total_liabilities = 0.0
    for r in rows:
        if r["is_liability"]:
            total_liabilities += r["balance"]
        else:
            total_assets += r["balance"]

    result = {
        "net_worth": total_assets - total_liabilities,
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "accounts": _rows_to_dicts(rows),
    }
    return json.dumps(result, indent=2)


@mcp.tool()
def get_balance_history(
    account_id: str | None = None,
    institution: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> str:
    """Get balance history over time.

    Args:
        account_id: Filter to a specific account by ID.
        institution: Filter to accounts at a specific institution.
        start_date: Start date (YYYY-MM-DD). Defaults to 90 days ago.
        end_date: End date (YYYY-MM-DD). Defaults to today.
    """
    conn = _get_conn()
    conditions = []
    params: list[str] = []

    if account_id:
        conditions.append("b.account_id = ?")
        params.append(account_id)
    if institution:
        conditions.append("a.institution = ?")
        params.append(institution)
    if start_date:
        conditions.append("b.as_of >= ?")
        params.append(start_date)
    else:
        from datetime import timedelta

        conditions.append("b.as_of >= ?")
        params.append((date.today() - timedelta(days=90)).isoformat())
    if end_date:
        conditions.append("b.as_of <= ?")
        params.append(end_date)

    where = " AND ".join(conditions) if conditions else "1=1"
    rows = conn.execute(
        f"""
        SELECT b.as_of, b.balance, b.source,
               COALESCE(a.display_name, a.name) AS account_name,
               a.institution, a.is_liability
        FROM balances b
        JOIN accounts a ON a.id = b.account_id
        WHERE {where}
        ORDER BY b.as_of, a.name
    """,
        params,
    ).fetchall()
    conn.close()
    return json.dumps(_rows_to_dicts(rows), indent=2)


@mcp.tool()
def get_transactions(
    account_id: str | None = None,
    institution: str | None = None,
    search: str | None = None,
    category: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int = 100,
) -> str:
    """Search and filter transactions.

    Args:
        account_id: Filter to a specific account.
        institution: Filter to an institution.
        search: Search term to match against description (case-insensitive).
        category: Filter by category_path prefix (e.g. 'Food' matches 'Food/Groceries').
        start_date: Start date (YYYY-MM-DD).
        end_date: End date (YYYY-MM-DD).
        limit: Max results (default 100).
    """
    conn = _get_conn()
    conditions = []
    params: list[str | int] = []

    if account_id:
        conditions.append("t.account_id = ?")
        params.append(account_id)
    if institution:
        conditions.append("a.institution = ?")
        params.append(institution)
    if search:
        conditions.append("t.description LIKE ?")
        params.append(f"%{search}%")
    if category:
        conditions.append("t.category_path LIKE ?")
        params.append(f"{category}%")
    if start_date:
        conditions.append("t.date >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("t.date <= ?")
        params.append(end_date)

    where = " AND ".join(conditions) if conditions else "1=1"
    rows = conn.execute(
        f"""
        SELECT t.id, t.date, t.amount, t.description,
               t.category_path, t.category,
               COALESCE(a.display_name, a.name) AS account_name,
               a.institution
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        WHERE {where}
        ORDER BY t.date DESC
        LIMIT ?
    """,
        [*params, limit],
    ).fetchall()
    conn.close()
    return json.dumps(_rows_to_dicts(rows), indent=2)


@mcp.tool()
def get_spending_summary(
    group_by: str = "category",
    start_date: str | None = None,
    end_date: str | None = None,
) -> str:
    """Summarize spending by category or month.

    Only includes expense transactions (negative amounts on non-liability accounts,
    positive amounts on liability/credit card accounts).

    Args:
        group_by: One of 'category', 'month', or 'month_category'.
        start_date: Start date (YYYY-MM-DD). Defaults to 90 days ago.
        end_date: End date (YYYY-MM-DD). Defaults to today.
    """
    conn = _get_conn()
    params: list[str] = []
    date_filter = ""

    if start_date:
        date_filter += " AND t.date >= ?"
        params.append(start_date)
    else:
        from datetime import timedelta

        date_filter += " AND t.date >= ?"
        params.append((date.today() - timedelta(days=90)).isoformat())
    if end_date:
        date_filter += " AND t.date <= ?"
        params.append(end_date)

    # Expenses: negative on assets, positive on liabilities (credit cards)
    expense_filter = """
        ((a.is_liability = 0 AND t.amount < 0) OR (a.is_liability = 1 AND t.amount > 0))
    """

    if group_by == "month":
        select = "SUBSTR(t.date, 1, 7) AS month"
        group = "SUBSTR(t.date, 1, 7)"
        order = "month"
    elif group_by == "month_category":
        select = (
            "SUBSTR(t.date, 1, 7) AS month, COALESCE(t.category_path, 'Uncategorized') AS category"
        )
        group = "SUBSTR(t.date, 1, 7), t.category_path"
        order = "month, total DESC"
    else:
        select = "COALESCE(t.category_path, 'Uncategorized') AS category"
        group = "t.category_path"
        order = "total DESC"

    rows = conn.execute(
        f"""
        SELECT {select}, SUM(ABS(t.amount)) AS total, COUNT(*) AS txn_count
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        WHERE {expense_filter} {date_filter}
        GROUP BY {group}
        ORDER BY {order}
    """,
        params,
    ).fetchall()
    conn.close()
    return json.dumps(_rows_to_dicts(rows), indent=2)


@mcp.tool()
def get_holdings(
    account_id: str | None = None,
    institution: str | None = None,
) -> str:
    """Get current portfolio holdings (latest snapshot per account).

    Args:
        account_id: Filter to a specific account.
        institution: Filter to an institution.
    """
    conn = _get_conn()
    conditions = [
        """h.as_of = (
        SELECT MAX(h2.as_of) FROM holdings h2 WHERE h2.account_id = h.account_id
    )"""
    ]
    params: list[str] = []

    if account_id:
        conditions.append("h.account_id = ?")
        params.append(account_id)
    if institution:
        conditions.append("a.institution = ?")
        params.append(institution)

    where = " AND ".join(conditions)
    rows = conn.execute(
        f"""
        SELECT h.symbol, h.name, h.asset_class, h.shares, h.value, h.as_of,
               COALESCE(a.display_name, a.name) AS account_name, a.institution
        FROM holdings h
        JOIN accounts a ON a.id = h.account_id
        WHERE {where}
        ORDER BY h.value DESC
    """,
        params,
    ).fetchall()
    conn.close()
    return json.dumps(_rows_to_dicts(rows), indent=2)


@mcp.tool()
def get_performance(
    account_id: str | None = None,
    institution: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> str:
    """Get investment performance history (balance, invested, earned over time).

    Args:
        account_id: Filter to a specific account.
        institution: Filter to an institution.
        start_date: Start date (YYYY-MM-DD).
        end_date: End date (YYYY-MM-DD).
    """
    conn = _get_conn()
    conditions = []
    params: list[str] = []

    if account_id:
        conditions.append("p.account_id = ?")
        params.append(account_id)
    if institution:
        conditions.append("a.institution = ?")
        params.append(institution)
    if start_date:
        conditions.append("p.date >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("p.date <= ?")
        params.append(end_date)

    where = " AND ".join(conditions) if conditions else "1=1"
    rows = conn.execute(
        f"""
        SELECT p.date, p.balance, p.invested, p.earned,
               COALESCE(a.display_name, a.name) AS account_name, a.institution
        FROM performance_history p
        JOIN accounts a ON a.id = p.account_id
        WHERE {where}
        ORDER BY p.date, a.name
    """,
        params,
    ).fetchall()
    conn.close()
    return json.dumps(_rows_to_dicts(rows), indent=2)


@mcp.tool()
def get_option_grants() -> str:
    """Get all stock option grants with current valuations."""
    conn = _get_conn()
    rows = conn.execute("""
        SELECT g.grant_date, g.grant_type, g.total_shares, g.vested_shares,
               g.strike_price, g.vested_value, g.expiration_date,
               COALESCE(a.display_name, a.name) AS account_name, a.institution,
               pv.fmv_per_share AS latest_fmv, pv.as_of AS fmv_date
        FROM option_grants g
        JOIN accounts a ON a.id = g.account_id
        LEFT JOIN private_valuations pv ON pv.account_id = g.account_id
            AND pv.as_of = (
                SELECT MAX(pv2.as_of) FROM private_valuations pv2
                WHERE pv2.account_id = g.account_id
            )
        ORDER BY g.grant_date
    """).fetchall()
    conn.close()
    return json.dumps(_rows_to_dicts(rows), indent=2)


@mcp.tool()
def get_sync_status() -> str:
    """Get the last sync time and account count for each institution/profile."""
    conn = _get_conn()
    rows = conn.execute("""
        SELECT s.institution, s.profile, s.status,
               s.started_at, s.finished_at,
               s.accounts, s.transactions, s.balances, s.holdings
        FROM sync_history s
        WHERE s.id = (
            SELECT s2.id FROM sync_history s2
            WHERE s2.institution = s.institution
              AND COALESCE(s2.profile, '') = COALESCE(s.profile, '')
            ORDER BY s2.started_at DESC LIMIT 1
        )
        ORDER BY s.institution
    """).fetchall()
    conn.close()
    return json.dumps(_rows_to_dicts(rows), indent=2)


@mcp.tool()
def query(sql: str) -> str:
    """Run a read-only SQL query against the database.

    Use this for ad-hoc queries not covered by other tools. The database is opened
    in read-only mode so writes will fail.

    Available tables: accounts, balances, transactions, performance_history,
    holdings, option_grants, private_valuations, ingestion_log, sync_history,
    transaction_tags, recurring_patterns, suggested_rules.

    Args:
        sql: A SELECT query to execute.
    """
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(sql).fetchall()
        return json.dumps(_rows_to_dicts(rows), indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})
    finally:
        conn.close()


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
