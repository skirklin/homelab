from collections.abc import Generator

import pytest

from money.db import Database


@pytest.fixture
def db() -> Generator[Database, None, None]:
    database = Database(":memory:")
    database.initialize()
    yield database
    database.close()
