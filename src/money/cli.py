import logging
from pathlib import Path

import click

from money.db import Database


@click.group()
@click.option(
    "--db",
    "db_path",
    default="money.db",
    type=click.Path(),
    help="Path to SQLite database.",
)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
@click.pass_context
def main(ctx: click.Context, db_path: str, verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    root = logging.getLogger()
    root.setLevel(level)
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(name)s %(levelname)s %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    root.addHandler(handler)
    ctx.ensure_object(dict)
    ctx.obj["db_path"] = db_path


@main.command()
@click.option("--raw-dir", default=None, type=click.Path(), help="Path to raw data directory.")
@click.pass_context
def replay(ctx: click.Context, raw_dir: str | None) -> None:
    """Delete the database and rebuild from raw captures."""
    from money.config import RAW_STORE_DIR
    from money.replay import replay_all

    db_path = ctx.obj["db_path"]
    raw = Path(raw_dir) if raw_dir else RAW_STORE_DIR
    replay_all(db_path=db_path, raw_dir=raw)
    click.echo(f"Replay complete. Database rebuilt at {db_path}")


@main.command()
@click.option("--keep-db", is_flag=True, help="Keep the database (only purge raw data).")
@click.pass_context
def purge(ctx: click.Context, keep_db: bool) -> None:
    """Delete all raw captures and optionally the database."""
    import shutil

    from money.config import RAW_STORE_DIR

    if RAW_STORE_DIR.exists():
        shutil.rmtree(RAW_STORE_DIR)
        RAW_STORE_DIR.mkdir(parents=True)
        click.echo(f"Purged raw data: {RAW_STORE_DIR}")
    else:
        click.echo("No raw data directory found.")

    if not keep_db:
        db_path = Path(ctx.obj["db_path"])
        for suffix in ("", "-wal", "-shm"):
            p = db_path.with_name(db_path.name + suffix) if suffix else db_path
            if p.exists():
                p.unlink()
        click.echo(f"Deleted database: {db_path}")


@main.command()
@click.pass_context
def init(ctx: click.Context) -> None:
    """Initialize the database."""
    db_path = ctx.obj["db_path"]
    db = Database(db_path)
    db.initialize()
    db.close()
    click.echo(f"Initialized database at {db_path}")


@main.command()
@click.pass_context
def categorize(ctx: click.Context) -> None:
    """Apply category rules from ~/.config/money/categories.yaml to all transactions."""
    from money.categorize import apply_rules

    db = Database(ctx.obj["db_path"])
    db.initialize()
    try:
        count = apply_rules(db)
        click.echo(f"Categorized {count} transactions.")
    finally:
        db.close()


@main.command()
@click.pass_context
def enrich(ctx: click.Context) -> None:
    """Enrich holdings with asset class data and fetch benchmark history."""
    from money.benchmarks import BENCHMARKS, enrich_holdings_asset_classes, fetch_yahoo_history

    db = Database(ctx.obj["db_path"])
    db.initialize()
    try:
        count = enrich_holdings_asset_classes(db)
        click.echo(f"Enriched {count} holdings with asset class data.")
    finally:
        db.close()

    for symbol, name in BENCHMARKS.items():
        data = fetch_yahoo_history(symbol)
        click.echo(f"Fetched {len(data)} data points for {name} ({symbol}).")


@main.command()
@click.pass_context
def detect_recurring(ctx: click.Context) -> None:
    """Detect recurring transaction patterns."""
    from money.recurring import detect_recurring as _detect
    from money.recurring import get_recurring_patterns

    db = Database(ctx.obj["db_path"])
    db.initialize()
    try:
        count = _detect(db)
        click.echo(f"Detected {count} recurring patterns.\n")
        patterns = get_recurring_patterns(db)
        for p in patterns:
            status = " [confirmed]" if p["status"] == "confirmed" else ""
            click.echo(
                f"  ${p['avg_amount']:>8,.2f}/{p['frequency']:<10s}"
                f"  (~${p['annual_cost']:>10,.2f}/yr)"
                f"  {p['match_count']:>3d}x  {p['description']}"
                f"  [{p['category_path'] or '?'}]{status}"
            )
    finally:
        db.close()


@main.command()
@click.option("-n", "--limit", default=50, help="Max uncategorized transactions to process.")
@click.pass_context
def suggest(ctx: click.Context, limit: int) -> None:
    """Generate AI-powered categorization suggestions for uncategorized transactions."""
    from money.suggest import generate_suggestions

    db = Database(ctx.obj["db_path"])
    db.initialize()
    try:
        count = generate_suggestions(db, limit)
        click.echo(f"Created {count} suggestions. Review in the web UI.")
    finally:
        db.close()


@main.command()
@click.pass_context
def pending_suggestions(ctx: click.Context) -> None:
    """List pending categorization suggestions."""
    from money.suggest import get_pending_suggestions

    db = Database(ctx.obj["db_path"])
    db.initialize()
    try:
        suggestions = get_pending_suggestions(db)
        if not suggestions:
            click.echo("No pending suggestions.")
            return
        for s in suggestions:
            n = len(s["matches"])
            click.echo(
                f"  [{s['id']}] {s['pattern']:30s} → {s['category_path']}"
                f"  ({n} matches, confidence {s['confidence']:.1f})"
            )
            click.echo(f"       {s['reasoning']}")
    finally:
        db.close()


@main.command()
@click.pass_context
def accounts(ctx: click.Context) -> None:
    """List all accounts."""
    db = Database(ctx.obj["db_path"])
    for account in db.list_accounts():
        liability = " (liability)" if account.is_liability else ""
        ext = f" ••{account.external_id}" if account.external_id else ""
        click.echo(f"  {account.name}{ext} [{account.account_type.value}]{liability}")
    db.close()


@main.command()
@click.pass_context
def category_stats(ctx: click.Context) -> None:
    """Show category_path distribution across transactions."""
    db = Database(ctx.obj["db_path"])
    db.initialize()
    rows = db.conn.execute("""
        SELECT category_path, COUNT(*) as cnt
        FROM transactions
        WHERE category_path IS NOT NULL
        GROUP BY category_path
        ORDER BY cnt DESC
    """).fetchall()
    total = db.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()
    categorized = sum(r["cnt"] for r in rows)
    assert total is not None
    click.echo(f"Categorized: {categorized} / {total[0]}")
    click.echo()
    for row in rows:
        click.echo(f"  {row['cnt']:>5d}  {row['category_path']}")
    db.close()


@main.command()
@click.option("-n", "--top", default=50, help="Number of groups to show.")
@click.pass_context
def uncategorized(ctx: click.Context, top: int) -> None:
    """Show uncategorized transactions grouped by description similarity."""
    db = Database(ctx.obj["db_path"])
    db.initialize()
    rows = db.conn.execute("""
        SELECT t.description, t.category, COUNT(*) as cnt,
               SUM(t.amount) as total, MIN(t.date) as first, MAX(t.date) as last
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        WHERE t.category_path IS NULL
          AND a.account_type IN ('checking', 'credit_card')
        GROUP BY t.description
        ORDER BY cnt DESC
        LIMIT ?
    """, (top,)).fetchall()
    total_uncategorized = db.conn.execute("""
        SELECT COUNT(*)
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        WHERE t.category_path IS NULL
          AND a.account_type IN ('checking', 'credit_card')
    """).fetchone()
    assert total_uncategorized is not None
    click.echo(f"Uncategorized: {total_uncategorized[0]} transactions\n")
    for row in rows:
        desc = row["description"] or "(no description)"
        cat = f"  [{row['category']}]" if row["category"] else ""
        click.echo(
            f"  {row['cnt']:>4d}x  ${abs(row['total']):>10,.2f}"
            f"  {row['first']}..{row['last']}"
            f"  {desc}{cat}"
        )
    db.close()


@main.command()
@click.option("-n", "--samples", default=5, help="Sample transactions per category.")
@click.pass_context
def category_audit(ctx: click.Context, samples: int) -> None:
    """Dump sample transactions per category_path for auditing."""
    db = Database(ctx.obj["db_path"])
    db.initialize()
    paths = db.conn.execute("""
        SELECT DISTINCT category_path FROM transactions
        WHERE category_path IS NOT NULL
        ORDER BY category_path
    """).fetchall()
    for row in paths:
        path = row["category_path"]
        txns = db.conn.execute("""
            SELECT t.description, t.category, t.amount, t.date
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            WHERE t.category_path = ?
              AND a.account_type IN ('checking', 'credit_card')
            ORDER BY RANDOM()
            LIMIT ?
        """, (path, samples)).fetchall()
        click.echo(f"\n=== {path} ({len(txns)} samples) ===")
        for t in txns:
            click.echo(
                f"  {t['date']}  ${abs(t['amount']):>10,.2f}"
                f"  {t['description']}"
                f"  [{t['category'] or ''}]"
            )
    db.close()


@main.command()
@click.argument("as_of", required=False)
@click.pass_context
def net_worth(ctx: click.Context, as_of: str | None) -> None:
    """Show net worth as of a date (default: today)."""
    from datetime import date

    target = date.fromisoformat(as_of) if as_of else date.today()
    db = Database(ctx.obj["db_path"])
    value = db.net_worth(target)
    click.echo(f"Net worth as of {target}: ${value:,.2f}")
    db.close()


@main.command()
@click.option("-n", "--limit", default=20, help="Number of transactions to show.")
@click.option("--account", "account_name", default=None, help="Filter by account name.")
@click.pass_context
def transactions(ctx: click.Context, limit: int, account_name: str | None) -> None:
    """Show recent transactions."""
    db = Database(ctx.obj["db_path"])
    query = "SELECT t.date, a.name, t.description, t.amount FROM transactions t"
    query += " JOIN accounts a ON t.account_id = a.id"
    params: list[object] = []
    if account_name:
        query += " WHERE a.name LIKE ?"
        params.append(f"%{account_name}%")
    query += " ORDER BY t.date DESC, t.rowid DESC LIMIT ?"
    params.append(limit)
    rows = db.conn.execute(query, params).fetchall()
    for row in rows:
        click.echo(f"  {row[0]}  {row[1]:<25s} {row[3]:>10.2f}  {row[2]}")
    db.close()


@main.command()
@click.pass_context
def balances(ctx: click.Context) -> None:
    """Show latest balance for each account."""
    db = Database(ctx.obj["db_path"])
    query = """
        SELECT a.name, b.as_of, b.balance, b.source
        FROM balances b
        JOIN accounts a ON b.account_id = a.id
        WHERE b.as_of = (SELECT MAX(b2.as_of) FROM balances b2 WHERE b2.account_id = b.account_id)
        ORDER BY a.name
    """
    rows = db.conn.execute(query).fetchall()
    if not rows:
        click.echo("No balance snapshots found.")
    for row in rows:
        click.echo(f"  {row[0]:<25s} ${row[2]:>12,.2f}  as of {row[1]}  ({row[3]})")
    db.close()


@main.command()
@click.option("--account", "account_name", default=None, help="Filter by account name.")
@click.argument("as_of", required=False)
@click.pass_context
def holdings(ctx: click.Context, account_name: str | None, as_of: str | None) -> None:
    """Show portfolio holdings as of a date (default: latest)."""
    db = Database(ctx.obj["db_path"])
    params: list[object] = []
    as_of_subquery = "SELECT MAX(h2.as_of) FROM holdings h2 WHERE h2.account_id = h.account_id"
    if as_of:
        as_of_subquery += " AND h2.as_of <= ?"
        params.append(as_of)

    conditions = [f"h.as_of = ({as_of_subquery})"]
    if account_name:
        conditions.append("a.name LIKE ?")
        params.append(f"%{account_name}%")

    query = f"""
        SELECT a.name AS account, h.as_of, h.symbol, h.name, h.asset_class,
               h.shares, h.value
        FROM holdings h
        JOIN accounts a ON h.account_id = a.id
        WHERE {" AND ".join(conditions)}
        ORDER BY a.name, h.value DESC
    """
    rows = db.conn.execute(query, params).fetchall()
    if not rows:
        click.echo("No holdings found.")
        db.close()
        return

    current_account = ""
    account_total = 0.0
    for row in rows:
        if row[0] != current_account:
            if current_account:
                click.echo(f"  {'':40s} {'Total':>10s} ${account_total:>12,.2f}")
                click.echo()
            current_account = row[0]
            account_total = 0.0
            click.echo(f"{current_account} (as of {row[1]}):")
        symbol = row[2] or "—"
        account_total += row[6]
        click.echo(f"  {symbol:<8s} {row[3]:<32s} {row[5]:>10.2f} sh  ${row[6]:>12,.2f}")
    if current_account:
        click.echo(f"  {'':40s} {'Total':>10s} ${account_total:>12,.2f}")
    db.close()


@main.command()
@click.option("-p", "--port", default=5555, help="Port to listen on.")
@click.option("--host", default="127.0.0.1", help="Host to bind to.")
@click.pass_context
def serve(ctx: click.Context, port: int, host: str) -> None:
    """Start local server to receive data from the Chrome extension."""
    from money.config import RAW_STORE_DIR
    from money.server import run_server
    from money.storage import LocalStore

    db_path = ctx.obj["db_path"]
    db = Database(db_path)
    db.initialize()

    store = LocalStore(RAW_STORE_DIR)

    click.echo(f"Starting server on http://{host}:{port}")
    try:
        run_server(db=db, store=store, port=port, host=host)
    finally:
        db.close()


@main.group()
def login() -> None:
    """Log into financial institutions to capture auth tokens/cookies."""


@login.command("google")
def login_google_cmd() -> None:
    """Authenticate with Google Calendar."""
    from money.calendar import auth

    auth()
    click.echo("Google Calendar auth complete.")


@login.command("ally")
@click.option("--profile", required=True, help="Credential profile (e.g. 'scott', 'angela').")
@click.option("--headless", is_flag=True, help="Run headless (no visible browser window).")
def login_ally_cmd(profile: str, headless: bool) -> None:
    """Log into Ally Bank to capture auth token."""
    from money.ingest.scrapers.ally import login_ally

    login_ally(profile, headless=headless)
    click.echo("Ally login complete — auth token saved.")


@main.group()
def sync() -> None:
    """Sync data from financial institutions."""


@sync.command()
@click.option("--profile", required=True, help="Credential profile (e.g. 'scott', 'angela').")
@click.pass_context
def ally(ctx: click.Context, profile: str) -> None:
    """Sync Ally Bank accounts. Auto-logs in if no auth token exists."""
    from money.config import RAW_STORE_DIR
    from money.ingest.ally_api import sync_ally_api
    from money.ingest.scrapers.ally import auth_token_path, login_ally
    from money.storage import LocalStore

    # Capture a fresh token if needed — must use immediately since SPA invalidates it
    token: str | None = None
    if not auth_token_path(profile).exists():
        click.echo("No auth token found — logging in via browser...")
        token = login_ally(profile, headless=True)

    db_path = ctx.obj["db_path"]
    db = Database(db_path)
    db.initialize()
    store = LocalStore(RAW_STORE_DIR)

    try:
        sync_ally_api(db, store, profile=profile, token=token)
        click.echo("Ally sync complete.")
    except Exception as e:
        click.echo(f"Ally sync failed: {e}", err=True)
        raise
    finally:
        db.close()


@sync.command()
@click.option("--profile", required=True, help="Credential profile (e.g. 'scott', 'angela').")
@click.option("--explore", is_flag=True, help="Exploratory mode: login and inspect page.")
@click.pass_context
def betterment(ctx: click.Context, profile: str, explore: bool) -> None:
    """Sync Betterment accounts."""
    if explore:
        from money.ingest.scrapers.betterment import explore_betterment

        explore_betterment(profile)
        return

    from money.config import RAW_STORE_DIR
    from money.ingest.betterment import sync_betterment
    from money.storage import LocalStore

    db_path = ctx.obj["db_path"]
    db = Database(db_path)
    db.initialize()
    store = LocalStore(RAW_STORE_DIR)

    try:
        sync_betterment(db, store, profile=profile)
        click.echo("Betterment sync complete.")
    except Exception as e:
        click.echo(f"Betterment sync failed: {e}", err=True)
        raise
    finally:
        db.close()


@sync.command()
@click.option("--profile", required=True, help="Credential profile (e.g. 'scott').")
@click.option("--explore", is_flag=True, help="Exploratory mode: login and inspect page.")
@click.pass_context
def wealthfront(ctx: click.Context, profile: str, explore: bool) -> None:
    """Sync Wealthfront accounts."""
    if explore:
        from money.ingest.scrapers.wealthfront import explore_wealthfront

        explore_wealthfront(profile)
        return

    from money.config import RAW_STORE_DIR
    from money.ingest.wealthfront import sync_wealthfront
    from money.storage import LocalStore

    db_path = ctx.obj["db_path"]
    db = Database(db_path)
    db.initialize()
    store = LocalStore(RAW_STORE_DIR)

    try:
        sync_wealthfront(db, store, profile=profile)
        click.echo("Wealthfront sync complete.")
    except Exception as e:
        click.echo(f"Wealthfront sync failed: {e}", err=True)
        raise
    finally:
        db.close()


@sync.command()
@click.option("--profile", required=True, help="Credential profile (e.g. 'scott').")
@click.pass_context
def capital_one(ctx: click.Context, profile: str) -> None:
    """Sync Capital One credit card accounts."""
    from money.config import RAW_STORE_DIR
    from money.ingest.capital_one import sync_capital_one
    from money.storage import LocalStore

    db_path = ctx.obj["db_path"]
    db = Database(db_path)
    db.initialize()
    store = LocalStore(RAW_STORE_DIR)

    try:
        sync_capital_one(db, store, profile=profile)
        click.echo("Capital One sync complete.")
    except Exception as e:
        click.echo(f"Capital One sync failed: {e}", err=True)
        raise
    finally:
        db.close()


@sync.command()
@click.pass_context
def chase(ctx: click.Context) -> None:
    """Sync Chase accounts from captured network log."""
    from money.config import RAW_STORE_DIR
    from money.ingest.chase import sync_chase
    from money.storage import LocalStore

    db_path = ctx.obj["db_path"]
    db = Database(db_path)
    db.initialize()
    store = LocalStore(RAW_STORE_DIR)

    try:
        sync_chase(db, store)
        click.echo("Chase sync complete.")
    except Exception as e:
        click.echo(f"Chase sync failed: {e}", err=True)
        raise
    finally:
        db.close()


@sync.command()
@click.option("--profile", required=True, help="Credential profile (e.g. 'scott').")
@click.pass_context
def morgan_stanley(ctx: click.Context, profile: str) -> None:
    """Sync Morgan Stanley Shareworks stock options/RSUs."""
    from money.config import RAW_STORE_DIR
    from money.ingest.morgan_stanley import sync_morgan_stanley
    from money.storage import LocalStore

    db_path = ctx.obj["db_path"]
    db = Database(db_path)
    db.initialize()
    store = LocalStore(RAW_STORE_DIR)

    try:
        sync_morgan_stanley(db, store, profile=profile)
        click.echo("Morgan Stanley sync complete.")
    except Exception as e:
        click.echo(f"Morgan Stanley sync failed: {e}", err=True)
        raise
    finally:
        db.close()
