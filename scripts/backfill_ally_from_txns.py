"""Reconstruct daily Ally balances by walking transactions backwards from known balance."""

import logging
from datetime import date, timedelta

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

from money.db import Database
from money.models import Balance

db = Database("money.db")
db.initialize()

inserted = 0

for acct in db.list_accounts():
    if acct.institution != "ally":
        continue

    # Get current balance
    latest = db.get_latest_balance(acct.id, date.today())
    if not latest:
        log.warning("No balance for %s, skipping", acct.name)
        continue

    # Get all transactions ordered by date desc
    rows = db.conn.execute(
        "SELECT date, amount FROM transactions WHERE account_id = ? ORDER BY date DESC",
        (acct.id,),
    ).fetchall()
    if not rows:
        log.info("%s: no transactions", acct.name)
        continue

    first_txn_date = date.fromisoformat(rows[-1]["date"])
    log.info(
        "%s: %d transactions (%s to %s), current balance $%,.2f",
        acct.name, len(rows), first_txn_date, rows[0]["date"], latest.balance,
    )

    # Group transaction amounts by date
    daily_delta: dict[date, float] = {}
    for r in rows:
        d = date.fromisoformat(r["date"])
        daily_delta[d] = daily_delta.get(d, 0.0) + r["amount"]

    # Walk backwards from today's balance
    # End-of-day balance on date D = balance after all transactions on D
    # So balance on D-1 = balance on D - sum(transactions on D)
    current = latest.balance
    d = date.today()
    count = 0

    while d >= first_txn_date:
        db.insert_balance(
            Balance(
                account_id=acct.id,
                as_of=d,
                balance=current,
                source="computed_from_transactions",
            )
        )
        count += 1
        inserted += 1

        # Walk back: subtract today's transactions to get yesterday's closing balance
        delta = daily_delta.get(d, 0.0)
        current -= delta
        d -= timedelta(days=1)

    log.info("  Inserted %d daily balances (%s to %s)", count, first_txn_date, date.today())

db.close()
log.info("\nDone. Total inserted: %d balance records", inserted)
