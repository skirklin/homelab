from datetime import date

from money.models import Account, AccountType, OptionGrant


def test_option_grant_fields() -> None:
    grant = OptionGrant(
        account_id="test",
        grant_date=date(2024, 2, 5),
        grant_type="ISO",
        total_shares=4800,
        vested_shares=1200,
        strike_price=12.98,
        vested_value=500000.0,
        vest_dates=[
            date(2025, 2, 5),
            date(2026, 2, 5),
            date(2027, 2, 5),
            date(2028, 2, 5),
        ],
        expiration_date=date(2034, 2, 5),
    )
    assert grant.total_shares == 4800
    assert grant.vested_shares == 1200
    assert grant.grant_type == "ISO"
    assert grant.strike_price == 12.98
    assert grant.expiration_date == date(2034, 2, 5)
    assert len(grant.vest_dates) == 4


def test_credit_card_auto_liability() -> None:
    account = Account(name="Visa", account_type=AccountType.CREDIT_CARD)
    assert account.is_liability is True


def test_checking_not_liability() -> None:
    account = Account(name="Checking", account_type=AccountType.CHECKING)
    assert account.is_liability is False
