"""Check what Ally transaction data we have in the DB."""

from money.db import Database

db = Database("money.db")

for acct in db.list_accounts():
    if acct.institution != "ally":
        continue
    count = db.conn.execute(
        "SELECT COUNT(*) as c FROM transactions WHERE account_id = ?", (acct.id,)
    ).fetchone()
    assert count is not None
    if count["c"] == 0:
        print(f"  {acct.name}: no transactions")
        continue

    minmax = db.conn.execute(
        "SELECT MIN(date) as first, MAX(date) as last FROM transactions WHERE account_id = ?",
        (acct.id,),
    ).fetchone()
    assert minmax is not None
    print(f"  {acct.name}: {count['c']} transactions ({minmax['first']} to {minmax['last']})")

    # Show a few
    rows = db.conn.execute(
        "SELECT date, amount, description FROM transactions WHERE account_id = ? ORDER BY date DESC LIMIT 5",
        (acct.id,),
    ).fetchall()
    for r in rows:
        print(f"    {r['date']}  {r['amount']:>10.2f}  {r['description']}")

db.close()
