from datetime import date

from money.db import Database
from money.models import Account, AccountType, Balance


def test_insert_and_get_account(db: Database) -> None:
    account = Account(name="Chase Checking", account_type=AccountType.CHECKING, institution="Chase")
    db.insert_account(account)

    retrieved = db.get_account(account.id)
    assert retrieved is not None
    assert retrieved.name == "Chase Checking"
    assert retrieved.account_type == AccountType.CHECKING
    assert retrieved.institution == "Chase"


def test_list_accounts(db: Database) -> None:
    db.insert_account(Account(name="B Account", account_type=AccountType.SAVINGS))
    db.insert_account(Account(name="A Account", account_type=AccountType.CHECKING))

    accounts = db.list_accounts()
    assert len(accounts) == 2
    assert accounts[0].name == "A Account"  # sorted by name


def test_credit_card_is_liability(db: Database) -> None:
    account = Account(name="Amex", account_type=AccountType.CREDIT_CARD)
    assert account.is_liability is True

    db.insert_account(account)
    retrieved = db.get_account(account.id)
    assert retrieved is not None
    assert retrieved.is_liability is True


def test_insert_and_get_balance(db: Database) -> None:
    account = Account(name="Checking", account_type=AccountType.CHECKING)
    db.insert_account(account)

    balance = Balance(
        account_id=account.id, as_of=date(2024, 1, 15), balance=1000.0, source="manual"
    )
    db.insert_balance(balance)

    latest = db.get_latest_balance(account.id, date(2024, 1, 15))
    assert latest is not None
    assert latest.balance == 1000.0

    # No balance before the recorded date
    assert db.get_latest_balance(account.id, date(2024, 1, 14)) is None


def test_net_worth_single_account(db: Database) -> None:
    account = Account(name="Checking", account_type=AccountType.CHECKING)
    db.insert_account(account)
    db.insert_balance(
        Balance(account_id=account.id, as_of=date(2024, 1, 1), balance=5000.0, source="manual")
    )

    assert db.net_worth(date(2024, 1, 1)) == 5000.0


def test_net_worth_with_liability(db: Database) -> None:
    checking = Account(name="Checking", account_type=AccountType.CHECKING)
    credit = Account(name="Visa", account_type=AccountType.CREDIT_CARD)
    db.insert_account(checking)
    db.insert_account(credit)

    db.insert_balance(
        Balance(account_id=checking.id, as_of=date(2024, 1, 1), balance=10000.0, source="manual")
    )
    db.insert_balance(
        Balance(account_id=credit.id, as_of=date(2024, 1, 1), balance=3000.0, source="manual")
    )

    assert db.net_worth(date(2024, 1, 1)) == 7000.0


def test_net_worth_uses_latest_balance(db: Database) -> None:
    account = Account(name="Checking", account_type=AccountType.CHECKING)
    db.insert_account(account)

    db.insert_balance(
        Balance(account_id=account.id, as_of=date(2024, 1, 1), balance=1000.0, source="manual")
    )
    db.insert_balance(
        Balance(account_id=account.id, as_of=date(2024, 2, 1), balance=2000.0, source="manual")
    )

    # As of Jan 15, should use the Jan 1 balance
    assert db.net_worth(date(2024, 1, 15)) == 1000.0
    # As of Feb 15, should use the Feb 1 balance
    assert db.net_worth(date(2024, 2, 15)) == 2000.0


def test_net_worth_no_accounts(db: Database) -> None:
    assert db.net_worth(date(2024, 1, 1)) == 0.0


def test_get_or_create_account_dedupes_by_external_id(db: Database) -> None:
    a1 = db.get_or_create_account(
        name="Checking",
        account_type=AccountType.CHECKING,
        institution="ally",
        external_id="9383",
    )
    a2 = db.get_or_create_account(
        name="Checking",
        account_type=AccountType.CHECKING,
        institution="ally",
        external_id="9383",
    )
    assert a1.id == a2.id
    assert len(db.list_accounts()) == 1


def test_get_or_create_account_updates_name(db: Database) -> None:
    a1 = db.get_or_create_account(
        name="Old Name",
        account_type=AccountType.CHECKING,
        institution="ally",
        external_id="1234",
    )
    a2 = db.get_or_create_account(
        name="New Name",
        account_type=AccountType.CHECKING,
        institution="ally",
        external_id="1234",
    )
    assert a1.id == a2.id
    assert a2.name == "New Name"


def test_get_or_create_account_different_external_ids(db: Database) -> None:
    a1 = db.get_or_create_account(
        name="My Checking",
        account_type=AccountType.CHECKING,
        institution="ally",
        external_id="9383",
    )
    a2 = db.get_or_create_account(
        name="Joint Checking",
        account_type=AccountType.CHECKING,
        institution="ally",
        external_id="2216",
    )
    assert a1.id != a2.id
    assert len(db.list_accounts()) == 2
