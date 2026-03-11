from datetime import date

from money.ingest.parsers.ally import parse_ally_csv


def test_parse_4_column_format() -> None:
    csv_data = b"""Date, Description, Amount, Balance
01/15/2024, Direct Deposit, $2500.00, $5000.00
01/16/2024, Coffee Shop, -$5.50, $4994.50
01/17/2024, ATM Withdrawal, -$200.00, $4794.50
"""
    transactions, balance = parse_ally_csv(csv_data, account_id="test-acct")

    assert len(transactions) == 3
    assert transactions[0].amount == 2500.0
    assert transactions[0].date == date(2024, 1, 15)
    assert transactions[0].description == "Direct Deposit"

    assert transactions[1].amount == -5.50
    assert transactions[2].amount == -200.0

    assert balance is not None
    assert balance.balance == 4794.50
    assert balance.as_of == date(2024, 1, 17)
    assert balance.source == "ally_csv"


def test_parse_5_column_format() -> None:
    csv_data = b"""Date, Description, Credits, Debits, Balance
01/15/2024, Direct Deposit, $2500.00, $0.00, $5000.00
01/16/2024, Coffee Shop, $0.00, $5.50, $4994.50
"""
    transactions, balance = parse_ally_csv(csv_data, account_id="test-acct")

    assert len(transactions) == 2
    assert transactions[0].amount == 2500.0
    assert transactions[1].amount == -5.50

    assert balance is not None
    assert balance.balance == 4994.50


def test_parse_with_raw_file_ref() -> None:
    csv_data = b"""Date, Description, Amount, Balance
01/15/2024, Test, $100.00, $100.00
"""
    transactions, balance = parse_ally_csv(
        csv_data, account_id="test-acct", raw_file_ref="ally/20240115_test.csv"
    )

    assert transactions[0].raw_file_ref == "ally/20240115_test.csv"
    assert balance is not None
    assert balance.raw_file_ref == "ally/20240115_test.csv"


def test_parse_empty_csv() -> None:
    csv_data = b""
    transactions, balance = parse_ally_csv(csv_data, account_id="test-acct")

    assert transactions == []
    assert balance is None


def test_parse_with_bom() -> None:
    csv_data = (
        b"\xef\xbb\xbfDate, Description, Amount, Balance\n01/15/2024, Test, $100.00, $100.00\n"
    )
    transactions, balance = parse_ally_csv(csv_data, account_id="test-acct")

    assert len(transactions) == 1
    assert balance is not None


def test_balance_uses_latest_date() -> None:
    csv_data = b"""Date, Description, Amount, Balance
01/17/2024, Later, $50.00, $550.00
01/15/2024, Earlier, $100.00, $500.00
"""
    _, balance = parse_ally_csv(csv_data, account_id="test-acct")

    assert balance is not None
    assert balance.as_of == date(2024, 1, 17)
    assert balance.balance == 550.0
