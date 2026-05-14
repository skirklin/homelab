import logging
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

import click

from money.db import Database
from money.storage import LocalStore


@contextmanager
def sync_context(ctx: click.Context) -> Generator[tuple[Database, LocalStore], None, None]:
    """Context manager that sets up and tears down db + store for sync commands."""
    from money.config import RAW_STORE_DIR

    db = Database(ctx.obj["db_path"])
    db.initialize()
    store = LocalStore(RAW_STORE_DIR)
    try:
        yield db, store
    finally:
        db.close()


@click.group()
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Path to SQLite database (default: .data/money.db).",
)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
@click.pass_context
def main(ctx: click.Context, db_path: str | None, verbose: bool) -> None:
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
    from money.config import DB_PATH

    ctx.ensure_object(dict)
    ctx.obj["db_path"] = db_path or str(DB_PATH)


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
def open_banks() -> None:
    """Open all bank sites in the default browser for cookie/data capture."""
    import webbrowser

    from money.config import load_config

    config = load_config()
    for inst_id, inst in config.institutions.items():
        if inst.url:
            click.echo(f"Opening {inst.label or inst_id}...")
            webbrowser.open(inst.url)
    click.echo("All sites opened. The extension will auto-capture cookies and network data.")


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
@click.option("--host", default="0.0.0.0", help="Host to bind to.")
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


def _resolve_capture_path(capture_ref: str, unresolved: bool) -> Path:
    """Resolve a capture reference (filename, substring, institution name, or
    'latest') against the appropriate capture directory.

    Returns the resolved Path. Raises click.ClickException on miss / ambiguity.
    """
    from money.config import DATA_DIR

    directory = DATA_DIR / ("unresolved_captures" if unresolved else "network_logs")
    if not directory.is_dir():
        raise click.ClickException(f"Directory does not exist: {directory}")

    files = sorted(
        (p for p in directory.glob("*.json")),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not files:
        raise click.ClickException(f"No capture files in {directory}.")

    # 'latest' keyword
    if capture_ref == "latest":
        return files[0]

    # Exact filename match (with or without .json)
    for f in files:
        if f.name == capture_ref or f.stem == capture_ref:
            return f

    # Institution-name match: any filename starting with `<ref>_`. Return newest.
    inst_matches = [f for f in files if f.name.startswith(f"{capture_ref}_")]
    if inst_matches:
        return inst_matches[0]

    # Substring match against filenames
    sub_matches = [f for f in files if capture_ref in f.name]
    if len(sub_matches) == 1:
        return sub_matches[0]
    if len(sub_matches) > 1:
        candidates = "\n  ".join(f.name for f in sub_matches[:10])
        raise click.ClickException(
            f"Ambiguous capture ref '{capture_ref}'. Candidates:\n  {candidates}"
        )
    raise click.ClickException(f"No capture matched '{capture_ref}' in {directory}.")


def _institution_from_filename(name: str) -> str:
    """Extract the institution prefix from a capture filename.

    Filenames look like `{institution}_{timestamp}.json`. Returns the bit
    before the first `_`, or '—' if there's no underscore.
    """
    if "_" not in name:
        return "—"
    return name.split("_", 1)[0]


def _human_size(n: int) -> str:
    for unit in ("B", "K", "M", "G"):
        if n < 1024:
            return f"{n:>4d}{unit}" if unit == "B" else f"{n:>4.0f}{unit}"
        n_float = n / 1024
        if n_float < 1024:
            return f"{n_float:>4.1f}{unit}"
        n = int(n_float)
    return f"{n}G"


@main.group()
def capture() -> None:
    """Inspect and replay captured data from the extension."""


@capture.command("list")
@click.option("--unresolved", is_flag=True, help="Scope to /app/.data/unresolved_captures/.")
@click.option("--limit", "-n", default=10, type=int)
@click.option("--institution", default=None, help="Filter by institution substring.")
def capture_list(unresolved: bool, limit: int, institution: str | None) -> None:
    """List captured network logs (or unresolved captures with --unresolved)."""
    from datetime import datetime

    from money.config import DATA_DIR

    directory = DATA_DIR / ("unresolved_captures" if unresolved else "network_logs")
    if not directory.is_dir():
        click.echo(f"Directory does not exist: {directory}")
        return

    files = [p for p in directory.glob("*.json")]
    if institution:
        files = [p for p in files if institution.lower() in p.name.lower()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    files = files[:limit]

    if not files:
        click.echo(f"No captures found in {directory}.")
        return

    for f in files:
        stat = f.stat()
        mtime = datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")
        inst = _institution_from_filename(f.name)
        size = _human_size(stat.st_size)
        click.echo(f"{mtime}  {inst:<18s} {size}  {f.name}")


@capture.command("inspect")
@click.argument("capture_id")
@click.option("--unresolved", is_flag=True)
@click.option("--field", default=None, help="Dot-path to a single field, e.g. entries.0.url")
@click.option("--raw", is_flag=True, help="Dump the full JSON file.")
def capture_inspect(capture_id: str, unresolved: bool, field: str | None, raw: bool) -> None:
    """Inspect a single capture: structural summary, a single field, or raw dump."""
    import json as _json

    path = _resolve_capture_path(capture_id, unresolved)

    if raw:
        click.echo(path.read_text())
        return

    data = _json.loads(path.read_text())

    if field:
        cur: object = data
        for seg in field.split("."):
            if isinstance(cur, list):
                try:
                    idx = int(seg)
                except ValueError:
                    raise click.ClickException(
                        f"Field path expects integer at list, got '{seg}' (full path: {field})"
                    ) from None
                if idx < 0 or idx >= len(cur):
                    raise click.ClickException(
                        f"Index {idx} out of range at '{seg}' (full path: {field})"
                    )
                cur = cur[idx]
            elif isinstance(cur, dict):
                if seg not in cur:
                    raise click.ClickException(
                        f"Field '{seg}' not found in dict (full path: {field})"
                    )
                cur = cur[seg]
            else:
                raise click.ClickException(
                    f"Cannot descend into {type(cur).__name__} at '{seg}' (full path: {field})"
                )
        click.echo(_json.dumps(cur, indent=2))
        return

    # Structural summary
    click.echo(f"file:    {path}")
    if isinstance(data, dict):
        click.echo(f"keys:    {sorted(data.keys())}")
        entries = data.get("entries")
        if isinstance(entries, list):
            click.echo(f"entries: {len(entries)}")
            urls = []
            for e in entries[:30]:
                if isinstance(e, dict):
                    url = e.get("url")
                    if isinstance(url, str):
                        urls.append(url)
            if urls:
                click.echo("urls:")
                for u in urls:
                    click.echo(f"  {u}")
        cookies = data.get("cookies")
        if isinstance(cookies, list):
            names = []
            for c in cookies:
                if isinstance(c, dict):
                    n = c.get("name")
                    if isinstance(n, str):
                        names.append(n)
            click.echo(f"cookies: {len(cookies)} ({sorted(names)})")
    else:
        click.echo(f"top-level type: {type(data).__name__}")


@main.command("replay-capture")
@click.argument("capture_ref")
@click.option(
    "--as-login",
    "as_login",
    default=None,
    help="Override the user_identity field with this login_id.",
)
@click.option(
    "--url",
    default="http://localhost:5555/capture",
    help="Endpoint to POST to (default: in-pod loopback).",
)
@click.option(
    "--unresolved/--no-unresolved",
    default=True,
    help="Default source is unresolved_captures/. --no-unresolved uses network_logs/.",
)
def replay_capture(
    capture_ref: str, as_login: str | None, url: str, unresolved: bool,
) -> None:
    """Replay a stored capture by POSTing it to the /capture endpoint."""
    import json as _json
    from urllib.error import HTTPError, URLError
    from urllib.request import Request, urlopen

    path = _resolve_capture_path(capture_ref, unresolved)
    payload = _json.loads(path.read_text())
    if as_login is not None:
        payload["user_identity"] = as_login

    body = _json.dumps(payload).encode()
    req = Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    click.echo(f"Replaying {path.name} -> {url}")
    try:
        with urlopen(req) as resp:
            status = resp.status
            text = resp.read().decode("utf-8", errors="replace")
    except HTTPError as e:
        status = e.code
        text = e.read().decode("utf-8", errors="replace")
        click.echo(f"HTTP {status}\n{text}")
        raise click.ClickException(f"Replay failed with HTTP {status}") from e
    except URLError as e:
        raise click.ClickException(f"Connection error: {e.reason}") from e

    click.echo(f"HTTP {status}\n{text}")
    if not (200 <= status < 300):
        raise click.ClickException(f"Replay failed with HTTP {status}")


@main.group()
def login() -> None:
    """Log into financial institutions to capture auth tokens/cookies."""


@login.command("google")
def login_google_cmd() -> None:
    """Authenticate with Google Calendar."""
    from money.calendar import auth

    auth()
    click.echo("Google Calendar auth complete.")


@main.group()
def sync() -> None:
    """Sync data from financial institutions."""


def _load_cookies_for_sync(login_id: str, institution: str) -> dict[str, str]:
    """Load persisted cookies for a login."""
    import json

    from money.config import DATA_DIR

    path = DATA_DIR / "cookies" / f"{login_id}.json"
    if not path.exists():
        raise click.ClickException(
            f"No cookies for {login_id}. Visit {institution} in Chrome to capture cookies."
        )
    data = json.loads(path.read_text())
    return {c["name"]: c["value"] for c in data.get("cookies", [])}


# Institutions that use cookies for auth (as opposed to network logs)
_COOKIE_INSTITUTIONS = {"ally", "betterment", "wealthfront", "capital_one"}


def _register_sync_commands() -> None:
    """Dynamically create sync subcommands from the institution registry."""
    from money.ingest.registry import all_institutions

    for inst in all_institutions():
        if inst.name == "ally":
            continue  # has manual Playwright-based command above
        cmd_name = inst.name.replace("_", "-")
        label = inst.display_name or inst.name

        @sync.command(name=cmd_name, help=f"Sync {label} accounts.")
        @click.option(
            "--login", "--profile", "login_id",
            required=True,
            help=f"Login ID (e.g. 'scott@{inst.name}').",
        )
        @click.pass_context
        def sync_cmd(
            ctx: click.Context,
            login_id: str,
            _inst: object = inst,
        ) -> None:
            from money.config import resolve_login_id
            from money.ingest.registry import InstitutionInfo

            assert isinstance(_inst, InstitutionInfo)
            resolved = resolve_login_id(_inst.name, login_id)
            with sync_context(ctx) as (db, store):
                if _inst.name in _COOKIE_INSTITUTIONS:
                    cookies = _load_cookies_for_sync(resolved, _inst.name)
                    _inst.sync_fn(db, store, profile=resolved, cookies=cookies)
                else:
                    _inst.sync_fn(db, store, profile=resolved)
                click.echo(f"{_inst.display_name or _inst.name} sync complete.")


_register_sync_commands()
