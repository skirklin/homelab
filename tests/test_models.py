from datetime import date

from money.models import Account, AccountType, OptionGrant


def test_option_grant_vesting_before_cliff() -> None:
    grant = OptionGrant(
        account_id="test",
        grant_date=date(2024, 1, 1),
        total_shares=4800,
        strike_price=1.0,
        vesting_start=date(2024, 1, 1),
        vesting_months=48,
        cliff_months=12,
    )

    assert grant.vested_shares(date(2024, 6, 1)) == 0  # before cliff
    assert grant.vested_shares(date(2024, 12, 1)) == 0  # exactly at cliff boundary


def test_option_grant_vesting_after_cliff() -> None:
    grant = OptionGrant(
        account_id="test",
        grant_date=date(2024, 1, 1),
        total_shares=4800,
        strike_price=1.0,
        vesting_start=date(2024, 1, 1),
        vesting_months=48,
        cliff_months=12,
    )

    assert grant.vested_shares(date(2025, 1, 1)) == 1200  # 12 months = 25%
    assert grant.vested_shares(date(2026, 1, 1)) == 2400  # 24 months = 50%
    assert grant.vested_shares(date(2028, 1, 1)) == 4800  # fully vested


def test_option_grant_vesting_caps_at_total() -> None:
    grant = OptionGrant(
        account_id="test",
        grant_date=date(2024, 1, 1),
        total_shares=4800,
        strike_price=1.0,
        vesting_start=date(2024, 1, 1),
        vesting_months=48,
        cliff_months=12,
    )

    # Well past vesting end
    assert grant.vested_shares(date(2030, 1, 1)) == 4800


def test_credit_card_auto_liability() -> None:
    account = Account(name="Visa", account_type=AccountType.CREDIT_CARD)
    assert account.is_liability is True


def test_checking_not_liability() -> None:
    account = Account(name="Checking", account_type=AccountType.CHECKING)
    assert account.is_liability is False
