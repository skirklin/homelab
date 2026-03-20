import json
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from typing import Any


class AccountType(Enum):
    CHECKING = "checking"
    SAVINGS = "savings"
    CREDIT_CARD = "credit_card"
    BROKERAGE = "brokerage"
    IRA = "ira"
    FOUR_OH_ONE_K = "401k"
    STOCK_OPTIONS = "stock_options"
    REAL_ESTATE = "real_estate"


class VestingSchedule(Enum):
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"


class IngestionStatus(Enum):
    SUCCESS = "success"
    ERROR = "error"


LIABILITY_TYPES = frozenset({AccountType.CREDIT_CARD})


@dataclass
class Account:
    name: str
    account_type: AccountType
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    institution: str | None = None
    external_id: str | None = None
    currency: str = "USD"
    is_liability: bool = False
    metadata: dict[str, Any] = field(default_factory=lambda: dict[str, Any]())
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    def __post_init__(self) -> None:
        if self.account_type in LIABILITY_TYPES:
            self.is_liability = True

    @property
    def metadata_json(self) -> str:
        return json.dumps(self.metadata) if self.metadata else "{}"


@dataclass
class Balance:
    account_id: str
    as_of: date
    balance: float
    source: str
    id: int | None = None
    raw_file_ref: str | None = None
    recorded_at: datetime = field(default_factory=datetime.now)


@dataclass
class Transaction:
    account_id: str
    date: date
    amount: float
    id: int | None = None
    description: str | None = None
    category: str | None = None
    raw_file_ref: str | None = None
    recorded_at: datetime = field(default_factory=datetime.now)


@dataclass
class OptionGrant:
    account_id: str
    grant_date: date
    total_shares: int
    strike_price: float
    vesting_start: date
    vesting_months: int
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    cliff_months: int = 12
    vesting_schedule: VestingSchedule = VestingSchedule.MONTHLY
    expiration_date: date | None = None

    def vested_shares(self, as_of: date) -> int:
        months_elapsed = (as_of.year - self.vesting_start.year) * 12 + (
            as_of.month - self.vesting_start.month
        )
        if months_elapsed < self.cliff_months:
            return 0
        return min(self.total_shares, self.total_shares * months_elapsed // self.vesting_months)


@dataclass
class PrivateValuation:
    account_id: str
    as_of: date
    fmv_per_share: float
    id: int | None = None
    source: str | None = None
    recorded_at: datetime = field(default_factory=datetime.now)


@dataclass
class Holding:
    account_id: str
    as_of: date
    name: str
    shares: float
    value: float
    source: str
    id: int | None = None
    symbol: str | None = None
    asset_class: str | None = None
    raw_file_ref: str | None = None
    recorded_at: datetime = field(default_factory=datetime.now)


@dataclass
class CategoryRule:
    pattern: str
    tag: str
    priority: int = 0
    display_category: str | None = None
    id: int | None = None


@dataclass
class IngestionRecord:
    source: str
    status: IngestionStatus
    id: int | None = None
    raw_file_ref: str | None = None
    error_message: str | None = None
    started_at: datetime = field(default_factory=datetime.now)
    finished_at: datetime | None = None
