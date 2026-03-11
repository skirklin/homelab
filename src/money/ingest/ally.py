"""Ally Bank ingester — scrape + parse + store."""

import logging
from datetime import date, datetime

from money.db import Database
from money.ingest.parsers.ally import parse_ally_csv
from money.ingest.scrapers.ally import scrape_ally
from money.models import Balance, IngestionRecord, IngestionStatus
from money.storage import RawStore

log = logging.getLogger(__name__)


def sync_ally(db: Database, store: RawStore, profile: str | None = None) -> None:
    """Full Ally Bank sync: scrape CSVs, store raw, parse, write to DB."""
    started_at = datetime.now()

    try:
        results = scrape_ally(profile=profile)

        for scraped_account, csv_path in results:
            account = db.get_or_create_account(
                name=scraped_account.name,
                account_type=scraped_account.account_type,
                institution="ally",
                external_id=scraped_account.external_id,
            )
            log.info("Syncing: %s [%s]", account.name, account.account_type.value)

            raw_data = csv_path.read_bytes()

            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            raw_key = f"ally/{timestamp}_{csv_path.name}"
            store.put(raw_key, raw_data)
            log.debug("Stored raw file: %s", raw_key)

            transactions, balance = parse_ally_csv(
                raw_data, account_id=account.id, raw_file_ref=raw_key
            )

            for txn in transactions:
                db.insert_transaction(txn)
            if balance:
                db.insert_balance(balance)

            # Also store balance from dashboard if CSV didn't have one
            if not balance and scraped_account.balance is not None:
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=date.today(),
                        balance=scraped_account.balance,
                        source="ally_dashboard",
                        raw_file_ref=raw_key,
                    )
                )

            log.info(
                "  %d transactions%s",
                len(transactions),
                f", balance: ${balance.balance:,.2f}" if balance else "",
            )

            db.insert_ingestion_record(
                IngestionRecord(
                    source="ally",
                    status=IngestionStatus.SUCCESS,
                    raw_file_ref=raw_key,
                    started_at=started_at,
                    finished_at=datetime.now(),
                )
            )

    except Exception as e:
        log.error("Ally sync failed: %s", e)
        db.insert_ingestion_record(
            IngestionRecord(
                source="ally",
                status=IngestionStatus.ERROR,
                error_message=str(e),
                started_at=started_at,
                finished_at=datetime.now(),
            )
        )
        raise
