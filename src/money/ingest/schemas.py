"""Typed schemas for raw API responses from financial institutions.

These TypedDicts represent the structure of raw JSON data as captured
from each institution's API. They're used to cast json.loads() output
so pyright can type-check field access throughout the parsers.
"""

from typing import TypedDict

# ── Morgan Stanley ────────────────────────────────────────────────────


class MSFutureVest(TypedDict):
    year: int
    monthIndex: int
    quantity: float
    value: str


class MSPortfolioItem(TypedDict):
    typeName: str
    instanceName: str
    modellingCategory: str
    availableQuantity: float
    availableValue: str
    inProgressQuantity: float
    inProgressValue: str
    fundId: int
    futureData: list[MSFutureVest]
    totalCashValue: str
    cashAward: bool
    cashFund: bool


class MSPortfolioSummary(TypedDict):
    companyStockFundId: int
    companyStockLabel: str
    companyStockPrice: str
    valuedAtPrice: str
    marketPriceLabel: str
    portfolioData: list[MSPortfolioItem]


class MSPortfolioSummaryResponse(TypedDict):
    data: MSPortfolioSummary


class MSExerciseDetails(TypedDict):
    vestDates: list[str]
    eligibleForExercise: bool


class MSGrant(TypedDict):
    awardName: str
    awardId: int
    fundId: int
    grantId: int
    grantName: str
    grantDate: str
    expiredDate: str
    grantNumber: str
    exerciseDetails: MSExerciseDetails
    quantityGranted: float
    isAutoExEnabled: bool


class MSGrantsResponse(TypedDict):
    data: list[MSGrant]


# ── Capital One ───────────────────────────────────────────────────────


class CONameInfo(TypedDict):
    name: str
    displayName: str
    productName: str
    nickname: str


class COCycleInfo(TypedDict):
    currentBalance: float
    lastStatement: float
    accountCycleDay: int


class COCardAccount(TypedDict):
    plasticIdLastFour: str
    nameInfo: CONameInfo
    cycleInfo: COCycleInfo


class COAccount(TypedDict):
    cardAccount: COCardAccount
    accountReferenceId: str


class COAccountsResponse(TypedDict):
    accounts: list[COAccount]


class COTransaction(TypedDict):
    transactionDate: str
    transactionAmount: float
    transactionDebitCredit: str
    transactionDescription: str
    displayCategory: str


# ── Ally ──────────────────────────────────────────────────────────────


class AllyDomainDetails(TypedDict, total=False):
    accountNickname: str
    externalAccountIndicator: bool
    accountId: str


class AllyAccount(TypedDict, total=False):
    accountNumberPvtEncrypt: str
    accountStatus: str
    accountType: str
    currentBalance: float
    nickname: str
    domainDetails: AllyDomainDetails


class AllyAccountsResponse(TypedDict):
    accounts: list[AllyAccount]


class AllyTransaction(TypedDict):
    transactionPostingDate: str
    transactionAmountPvtEncrypt: float
    transactionDescription: str
    transactionType: str
