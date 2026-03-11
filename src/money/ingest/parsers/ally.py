"""Parse Ally Bank CSV exports into normalized transactions and balances."""

import csv
import io
from datetime import date

from money.models import Balance, Transaction


def _parse_amount(raw: str) -> float:
    """Parse an amount string like '$1,234.56' or '-$50.00' into a float."""
    cleaned = raw.replace("$", "").replace(",", "").strip()
    if not cleaned or cleaned == "0.00":
        return 0.0
    return float(cleaned)


def _parse_date(raw: str) -> date:
    """Parse date from Ally CSV. Tries common US formats."""
    raw = raw.strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m-%d-%Y"):
        try:
            return date.fromisoformat(raw) if fmt == "%Y-%m-%d" else _strptime_date(raw, fmt)
        except ValueError:
            continue
    raise ValueError(f"Unrecognized date format: {raw}")


def _strptime_date(raw: str, fmt: str) -> date:
    from datetime import datetime

    return datetime.strptime(raw, fmt).date()


def parse_ally_csv(
    raw_csv: bytes,
    account_id: str,
    raw_file_ref: str | None = None,
) -> tuple[list[Transaction], Balance | None]:
    """Parse an Ally Bank CSV export.

    Handles known CSV variants:
      - 5 columns (current): Date, Time, Amount, Type, Description
      - 4 columns (legacy):  Date, Description, Amount, Balance
      - 5 columns (legacy):  Date, Description, Credits, Debits, Balance

    Returns parsed transactions and the most recent balance snapshot (if available).
    """
    text = raw_csv.decode("utf-8-sig")  # Handle BOM if present
    reader = csv.DictReader(io.StringIO(text))

    if reader.fieldnames is None:
        return [], None

    headers = [h.strip().lower() for h in reader.fieldnames]
    has_time = "time" in headers
    is_split_format = "credits" in headers or "debits" in headers

    transactions: list[Transaction] = []
    latest_date: date | None = None
    latest_balance: float | None = None

    for row in reader:
        # Normalize keys
        normalized = {k.strip().lower(): v.strip() for k, v in row.items()}

        txn_date = _parse_date(normalized["date"])

        if is_split_format:
            credits = _parse_amount(normalized.get("credits", "0"))
            debits = _parse_amount(normalized.get("debits", "0"))
            amount = credits - debits
        else:
            amount = _parse_amount(normalized["amount"])

        description = normalized.get("description", "")
        # Current format has a "type" column (Deposit/Withdrawal) — include if no description
        if has_time and not description:
            description = normalized.get("type", "")

        transactions.append(
            Transaction(
                account_id=account_id,
                date=txn_date,
                amount=amount,
                description=description,
                raw_file_ref=raw_file_ref,
            )
        )

        # Track the most recent row's balance for the snapshot
        balance_str = normalized.get("balance", "")
        if balance_str:
            row_balance = _parse_amount(balance_str)
            if latest_date is None or txn_date >= latest_date:
                latest_date = txn_date
                latest_balance = row_balance

    balance_snapshot = None
    if latest_date is not None and latest_balance is not None:
        balance_snapshot = Balance(
            account_id=account_id,
            as_of=latest_date,
            balance=latest_balance,
            source="ally_csv",
            raw_file_ref=raw_file_ref,
        )

    return transactions, balance_snapshot
