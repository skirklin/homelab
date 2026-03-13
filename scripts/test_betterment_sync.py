"""Test all ingesters and show combined view."""

import logging
from datetime import date

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

from money.config import RAW_STORE_DIR
from money.db import Database
from money.storage import LocalStore

db = Database("money.db")
db.initialize()
store = LocalStore(RAW_STORE_DIR)

# Sync Betterment
print("\n=== Syncing Betterment ===")
try:
    from money.ingest.betterment import sync_betterment
    sync_betterment(db, store, profile="scott")
except Exception as e:
    print(f"  FAILED: {e}")

# Sync Wealthfront
print("\n=== Syncing Wealthfront ===")
try:
    from money.ingest.wealthfront import sync_wealthfront
    sync_wealthfront(db, store, profile="scott")
except Exception as e:
    print(f"  FAILED: {e}")

# Show combined view
print("\n" + "=" * 70)
print("  AGGREGATED VIEW")
print("=" * 70)

today = date.today()
total = 0.0
by_institution: dict[str, float] = {}
by_type: dict[str, float] = {}

for acct in db.list_accounts():
    bal = db.get_latest_balance(acct.id, today)
    if not bal:
        continue
    inst = acct.institution or "unknown"
    acct_type = acct.account_type.value

    total += bal.balance
    by_institution[inst] = by_institution.get(inst, 0) + bal.balance
    by_type[acct_type] = by_type.get(acct_type, 0) + bal.balance

    print(f"  {inst:<15s} {acct.name:<35s} [{acct_type:<10s}] ${bal.balance:>12,.2f}")

print(f"\n  {'─' * 60}")
print(f"  By Institution:")
for inst, val in sorted(by_institution.items()):
    print(f"    {inst:<15s} ${val:>12,.2f}")
print(f"\n  By Account Type:")
for t, val in sorted(by_type.items()):
    print(f"    {t:<15s} ${val:>12,.2f}")
print(f"\n  {'─' * 60}")
print(f"  NET WORTH:       ${total:>12,.2f}")

db.close()
