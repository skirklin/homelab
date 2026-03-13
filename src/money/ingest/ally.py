"""Ally Bank ingester — scrape + parse + store."""

import json
import logging
from datetime import date, datetime

from money.db import Database
from money.ingest.parsers.ally import parse_ally_csv
from money.ingest.scrapers.ally import scrape_ally
from money.models import Balance, IngestionRecord, IngestionStatus
from money.storage import RawStore

log = logging.getLogger(__name__)


def sync_ally(db: Database, store: RawStore, profile: str) -> None:
    """Full Ally Bank sync: scrape CSVs, store raw, parse, write to DB."""
    started_at = datetime.now()

    try:
        results = scrape_ally(profile=profile)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        for scraped_account, csv_path in results:
            prefix = f"ally/{timestamp}_{scraped_account.external_id}"

            # Store the raw CSV
            csv_key = f"{prefix}.csv"
            store.put(csv_key, csv_path.read_bytes())

            # Store account metadata alongside it
            manifest = {
                "institution": "ally",
                "profile": profile,
                "account_name": scraped_account.name,
                "account_type": scraped_account.account_type.value,
                "external_id": scraped_account.external_id,
                "balance": scraped_account.balance,
                "scraped_at": timestamp,
            }
            store.put(f"{prefix}.json", json.dumps(manifest, indent=2).encode())

            log.debug("Stored raw files: %s.{csv,json}", prefix)

            # Resolve or create the account
            account = db.get_or_create_account(
                name=scraped_account.name,
                account_type=scraped_account.account_type,
                institution="ally",
                external_id=scraped_account.external_id,
            )
            log.info("Syncing: %s [%s]", account.name, account.account_type.value)

            # Parse and insert transactions
            transactions, balance = parse_ally_csv(
                csv_path.read_bytes(), account_id=account.id, raw_file_ref=csv_key
            )
            for txn in transactions:
                db.insert_transaction(txn)
            if balance:
                db.insert_balance(balance)

            # Dashboard balance as fallback
            if not balance and scraped_account.balance is not None:
                db.insert_balance(
                    Balance(
                        account_id=account.id,
                        as_of=date.today(),
                        balance=scraped_account.balance,
                        source="ally_dashboard",
                        raw_file_ref=csv_key,
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
                    raw_file_ref=csv_key,
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
