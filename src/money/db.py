import sqlite3
from datetime import date, datetime
from importlib import resources
from pathlib import Path

from money.models import (
    Account,
    AccountType,
    Balance,
    IngestionRecord,
    OptionGrant,
    PrivateValuation,
    Transaction,
    VestingSchedule,
)

SCHEMA_VERSION = 1


class Database:
    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        self.conn = sqlite3.connect(self.path)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.row_factory = sqlite3.Row

    def close(self) -> None:
        self.conn.close()

    def initialize(self) -> None:
        schema_sql = resources.files("money").joinpath("schema.sql").read_text()
        self.conn.executescript(schema_sql)
        self._migrate()

    def _migrate(self) -> None:
        """Apply schema migrations for existing databases."""
        columns = {
            row["name"] for row in self.conn.execute("PRAGMA table_info(accounts)").fetchall()
        }
        if "external_id" not in columns:
            self.conn.execute("ALTER TABLE accounts ADD COLUMN external_id TEXT")
            self.conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_ext "
                "ON accounts(institution, external_id)"
            )
            self.conn.commit()

    # -- Accounts --

    def insert_account(self, account: Account) -> None:
        self.conn.execute(
            """INSERT INTO accounts (id, name, institution, external_id, account_type,
               currency, is_liability, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                account.id,
                account.name,
                account.institution,
                account.external_id,
                account.account_type.value,
                account.currency,
                int(account.is_liability),
                account.metadata_json,
                account.created_at.isoformat(),
                account.updated_at.isoformat(),
            ),
        )
        self.conn.commit()

    def get_account(self, account_id: str) -> Account | None:
        row = self.conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if row is None:
            return None
        return _row_to_account(row)

    def get_account_by_external_id(self, institution: str, external_id: str) -> Account | None:
        row = self.conn.execute(
            "SELECT * FROM accounts WHERE institution = ? AND external_id = ?",
            (institution, external_id),
        ).fetchone()
        if row is None:
            return None
        return _row_to_account(row)

    def get_or_create_account(
        self,
        name: str,
        account_type: AccountType,
        institution: str,
        external_id: str,
    ) -> Account:
        existing = self.get_account_by_external_id(institution, external_id)
        if existing is not None:
            # Update name if it changed (e.g. user renamed account)
            if existing.name != name:
                self.conn.execute(
                    "UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?",
                    (name, datetime.now().isoformat(), existing.id),
                )
                self.conn.commit()
                existing.name = name
            return existing
        account = Account(
            name=name,
            account_type=account_type,
            institution=institution,
            external_id=external_id,
        )
        self.insert_account(account)
        return account

    def list_accounts(self) -> list[Account]:
        rows = self.conn.execute("SELECT * FROM accounts ORDER BY name").fetchall()
        return [_row_to_account(r) for r in rows]

    # -- Balances --

    def insert_balance(self, balance: Balance) -> None:
        self.conn.execute(
            """INSERT INTO balances (account_id, as_of, balance, source, raw_file_ref, recorded_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                balance.account_id,
                balance.as_of.isoformat(),
                balance.balance,
                balance.source,
                balance.raw_file_ref,
                balance.recorded_at.isoformat(),
            ),
        )
        self.conn.commit()

    def get_latest_balance(self, account_id: str, as_of: date) -> Balance | None:
        row = self.conn.execute(
            """SELECT * FROM balances
               WHERE account_id = ? AND as_of <= ?
               ORDER BY as_of DESC, recorded_at DESC
               LIMIT 1""",
            (account_id, as_of.isoformat()),
        ).fetchone()
        if row is None:
            return None
        return _row_to_balance(row)

    # -- Transactions --

    def insert_transaction(self, txn: Transaction) -> None:
        self.conn.execute(
            """INSERT INTO transactions (account_id, date, amount, description, category,
               raw_file_ref, recorded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                txn.account_id,
                txn.date.isoformat(),
                txn.amount,
                txn.description,
                txn.category,
                txn.raw_file_ref,
                txn.recorded_at.isoformat(),
            ),
        )
        self.conn.commit()

    # -- Option Grants --

    def insert_option_grant(self, grant: OptionGrant) -> None:
        self.conn.execute(
            """INSERT INTO option_grants (id, account_id, grant_date, total_shares, strike_price,
               vesting_start, vesting_months, cliff_months, vesting_schedule, expiration_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                grant.id,
                grant.account_id,
                grant.grant_date.isoformat(),
                grant.total_shares,
                grant.strike_price,
                grant.vesting_start.isoformat(),
                grant.vesting_months,
                grant.cliff_months,
                grant.vesting_schedule.value,
                grant.expiration_date.isoformat() if grant.expiration_date else None,
            ),
        )
        self.conn.commit()

    def get_option_grants(self, account_id: str) -> list[OptionGrant]:
        rows = self.conn.execute(
            "SELECT * FROM option_grants WHERE account_id = ?", (account_id,)
        ).fetchall()
        return [_row_to_option_grant(r) for r in rows]

    # -- Private Valuations --

    def insert_private_valuation(self, valuation: PrivateValuation) -> None:
        self.conn.execute(
            """INSERT INTO private_valuations
               (account_id, as_of, fmv_per_share, source, recorded_at)
               VALUES (?, ?, ?, ?, ?)""",
            (
                valuation.account_id,
                valuation.as_of.isoformat(),
                valuation.fmv_per_share,
                valuation.source,
                valuation.recorded_at.isoformat(),
            ),
        )
        self.conn.commit()

    def get_latest_valuation(self, account_id: str, as_of: date) -> PrivateValuation | None:
        row = self.conn.execute(
            """SELECT * FROM private_valuations
               WHERE account_id = ? AND as_of <= ?
               ORDER BY as_of DESC, recorded_at DESC
               LIMIT 1""",
            (account_id, as_of.isoformat()),
        ).fetchone()
        if row is None:
            return None
        return _row_to_private_valuation(row)

    # -- Ingestion Log --

    def insert_ingestion_record(self, record: IngestionRecord) -> int:
        cursor = self.conn.execute(
            """INSERT INTO ingestion_log (source, status, raw_file_ref, error_message,
               started_at, finished_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                record.source,
                record.status.value,
                record.raw_file_ref,
                record.error_message,
                record.started_at.isoformat(),
                record.finished_at.isoformat() if record.finished_at else None,
            ),
        )
        self.conn.commit()
        assert cursor.lastrowid is not None
        return cursor.lastrowid

    # -- Net Worth --

    def net_worth(self, as_of: date) -> float:
        row = self.conn.execute(
            """SELECT COALESCE(SUM(
                   CASE WHEN a.is_liability THEN -b.balance ELSE b.balance END
               ), 0.0) AS net_worth
               FROM accounts a
               JOIN balances b ON b.account_id = a.id
               WHERE b.id = (
                   SELECT b2.id FROM balances b2
                   WHERE b2.account_id = a.id AND b2.as_of <= ?
                   ORDER BY b2.as_of DESC, b2.recorded_at DESC
                   LIMIT 1
               )""",
            (as_of.isoformat(),),
        ).fetchone()
        assert row is not None
        return float(row["net_worth"])


# -- Row conversion helpers --


def _parse_datetime(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _parse_date(s: str) -> date:
    return date.fromisoformat(s)


def _row_to_account(row: sqlite3.Row) -> Account:
    import json

    return Account(
        id=row["id"],
        name=row["name"],
        institution=row["institution"],
        external_id=row["external_id"],
        account_type=AccountType(row["account_type"]),
        currency=row["currency"],
        is_liability=bool(row["is_liability"]),
        metadata=json.loads(row["metadata"]) if row["metadata"] else {},
        created_at=_parse_datetime(row["created_at"]),
        updated_at=_parse_datetime(row["updated_at"]),
    )


def _row_to_balance(row: sqlite3.Row) -> Balance:
    return Balance(
        id=row["id"],
        account_id=row["account_id"],
        as_of=_parse_date(row["as_of"]),
        balance=row["balance"],
        source=row["source"],
        raw_file_ref=row["raw_file_ref"],
        recorded_at=_parse_datetime(row["recorded_at"]),
    )


def _row_to_option_grant(row: sqlite3.Row) -> OptionGrant:
    return OptionGrant(
        id=row["id"],
        account_id=row["account_id"],
        grant_date=_parse_date(row["grant_date"]),
        total_shares=row["total_shares"],
        strike_price=row["strike_price"],
        vesting_start=_parse_date(row["vesting_start"]),
        vesting_months=row["vesting_months"],
        cliff_months=row["cliff_months"],
        vesting_schedule=VestingSchedule(row["vesting_schedule"]),
        expiration_date=_parse_date(row["expiration_date"]) if row["expiration_date"] else None,
    )


def _row_to_private_valuation(row: sqlite3.Row) -> PrivateValuation:
    return PrivateValuation(
        id=row["id"],
        account_id=row["account_id"],
        as_of=_parse_date(row["as_of"]),
        fmv_per_share=row["fmv_per_share"],
        source=row["source"],
        recorded_at=_parse_datetime(row["recorded_at"]),
    )
