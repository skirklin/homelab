"""Sync all institutions and show combined view."""

import logging
from datetime import date

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

from money.config import RAW_STORE_DIR
from money.db import Database
from money.storage import LocalStore

db = Database("money.db")
db.initialize()
store = LocalStore(RAW_STORE_DIR)

# Sync Betterment (with fresh cookies)
print("\n=== Syncing Betterment ===")
try:
    from money.ingest.betterment import sync_betterment
    sync_betterment(db, store, profile="scott")
except Exception as e:
    print(f"  FAILED: {e}")

# Show results
print("\n" + "=" * 70)
print("  BALANCE HISTORY SUMMARY")
print("=" * 70)

for acct in db.list_accounts():
    count = db.conn.execute(
        "SELECT COUNT(*) as c FROM balances WHERE account_id = ?", (acct.id,)
    ).fetchone()
    assert count is not None
    bal = db.get_latest_balance(acct.id, date.today())
    bal_str = f"${bal.balance:>12,.2f}" if bal else "no balance"
    inst = acct.institution or "?"
    print(f"  {inst:<15s} {acct.name:<35s} {count['c']:>5d} points  {bal_str}")

db.close()
