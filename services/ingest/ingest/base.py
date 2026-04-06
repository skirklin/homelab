from typing import Protocol

from money.db import Database
from money.storage import RawStore


class Ingester(Protocol):
    def sync(self, db: Database, store: RawStore) -> None: ...
