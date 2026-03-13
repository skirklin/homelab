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
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    ctx.ensure_object(dict)
    ctx.obj["db_path"] = db_path


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
def accounts(ctx: click.Context) -> None:
    """List all accounts."""
    db = Database(ctx.obj["db_path"])
    for account in db.list_accounts():
        liability = " (liability)" if account.is_liability else ""
        ext = f" ••{account.external_id}" if account.external_id else ""
        click.echo(f"  {account.name}{ext} [{account.account_type.value}]{liability}")
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
def sync() -> None:
    """Sync data from financial institutions."""


@sync.command()
@click.option("--profile", required=True, help="Credential profile (e.g. 'scott', 'angela').")
@click.option("--cookies", is_flag=True, help="Use relayed auth token from Chrome extension.")
@click.pass_context
def ally(ctx: click.Context, profile: str, cookies: bool) -> None:
    """Sync Ally Bank accounts."""
    from money.config import RAW_STORE_DIR, load_config
    from money.storage import DualStore, GCSStore, LocalStore

    config = load_config()
    local = LocalStore(RAW_STORE_DIR)
    store: LocalStore | DualStore
    if config.gcs_bucket:
        store = DualStore(
            local, GCSStore(config.gcs_bucket, project=config.gcs_project, prefix="raw")
        )
    else:
        store = local

    db_path = ctx.obj["db_path"]
    db = Database(db_path)
    db.initialize()

    try:
        if cookies:
            from money.ingest.ally_api import sync_ally_api

            sync_ally_api(db, store, profile=profile)
        else:
            from money.ingest.ally import sync_ally

            sync_ally(db, store, profile=profile)
    finally:
        db.close()

    # Back up the DB to GCS after sync
    if config.gcs_bucket:
        gcs = GCSStore(config.gcs_bucket, project=config.gcs_project)
        gcs.put("money.db", Path(db_path).read_bytes())
        click.echo(f"Backed up database to gs://{config.gcs_bucket}/money.db")


@sync.command()
@click.option("--profile", required=True, help="Credential profile (e.g. 'scott', 'angela').")
@click.option("--explore", is_flag=True, help="Exploratory mode: login and inspect page.")
@click.option("--cookies", is_flag=True, help="Use relayed cookies from Chrome extension.")
@click.pass_context
def betterment(ctx: click.Context, profile: str, explore: bool, cookies: bool) -> None:
    """Sync Betterment accounts."""
    if explore:
        from money.ingest.scrapers.betterment import explore_betterment

        explore_betterment(profile)
        return

    if cookies:
        from money.config import RAW_STORE_DIR
        from money.ingest.betterment import sync_betterment
        from money.storage import LocalStore

        db_path = ctx.obj["db_path"]
        db = Database(db_path)
        db.initialize()
        store = LocalStore(RAW_STORE_DIR)

        try:
            sync_betterment(db, store, profile=profile)
        finally:
            db.close()
        return


@sync.command()
@click.option("--profile", required=True, help="Credential profile (e.g. 'scott').")
@click.option("--explore", is_flag=True, help="Exploratory mode: login and inspect page.")
@click.option("--camoufox", is_flag=True, help="Use camoufox anti-detect browser.")
@click.option("--cookies", is_flag=True, help="Use relayed cookies from Chrome extension.")
@click.pass_context
def wealthfront(
    ctx: click.Context, profile: str, explore: bool, camoufox: bool, cookies: bool,
) -> None:
    """Sync Wealthfront accounts."""
    if explore:
        if cookies:
            from money.ingest.scrapers.wealthfront import explore_wealthfront_cookies

            explore_wealthfront_cookies(profile)
            return
        from money.ingest.scrapers.wealthfront import explore_wealthfront

        explore_wealthfront(profile, use_camoufox=camoufox)
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
    finally:
        db.close()
