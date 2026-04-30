"""Pydantic schemas for raw API responses from financial institutions.

These models represent the structure of raw JSON data as captured
from each institution's API. They validate at parse time so schema
mismatches surface immediately with clear error messages.

Fields are required by default. A field is only `| None` when there is a
documented structural reason it can be absent (GraphQL inline fragments,
account-type-dependent fields, etc.) — never to paper over data issues.
"""

from pydantic import BaseModel, ConfigDict, Field

# All institution schemas ignore extra fields — APIs often return
# more than we need, and we don't want to break on new fields.


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore")


class _GraphQLBase(_Base):
    """Base for Betterment GraphQL types that include __typename."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    typename: str | None = Field(default=None, alias="__typename")


# ── Morgan Stanley ────────────────────────────────────────────────────
# All fields always present in Shareworks API responses.


class MSFutureVest(_Base):
    year: int
    monthIndex: int
    quantity: float
    value: str


class MSPortfolioItem(_Base):
    typeName: str
    instanceName: str | None = None  # absent on cash holding items
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


class MSPortfolioSummary(_Base):
    companyStockFundId: int
    companyStockLabel: str
    companyStockPrice: str
    valuedAtPrice: str
    marketPriceLabel: str
    portfolioData: list[MSPortfolioItem]


class MSPortfolioSummaryResponse(_Base):
    data: MSPortfolioSummary


class MSExerciseDetails(_Base):
    vestDates: list[str]
    eligibleForExercise: bool


class MSGrant(_Base):
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


class MSGrantsResponse(_Base):
    data: list[MSGrant]


# ── Capital One ───────────────────────────────────────────────────────
# All fields always present except CONameInfo.nickname (absent on some cards
# like REI — key missing entirely).


class CONameInfo(_Base):
    name: str
    displayName: str
    productName: str
    nickname: str | None = None  # absent on some card types (e.g. REI)


class COLastStatement(_Base):
    balance: float
    date: str


class COCycleInfo(_Base):
    currentBalance: float
    lastStatement: COLastStatement
    accountCycleDay: int


class COCardAccount(_Base):
    plasticIdLastFour: str
    nameInfo: CONameInfo
    cycleInfo: COCycleInfo


class COAccount(_Base):
    cardAccount: COCardAccount
    accountReferenceId: str


class COAccountsResponse(_Base):
    accounts: list[COAccount]


class COTransaction(_Base):
    transactionDate: str
    transactionAmount: float
    transactionDebitCredit: str
    transactionDescription: str
    displayCategory: str


# ── Betterment ────────────────────────────────────────────────────────
# GraphQL API — inline fragments (`... on ManagedAccount`) produce fields
# that are absent for non-matching account types. Those are `| None`.
# Fields on the base query (not inside fragments) are always present.


class BMPurposeRef(_GraphQLBase):
    id: str
    name: str


class BMAccount(_GraphQLBase):
    """Betterment account from sidebar query.

    name/nameOverride/accountDescription come from GraphQL inline fragments
    (`... on ManagedAccount`, `... on CashAccount`, etc.) and are absent
    for account types that don't match any fragment.
    """

    id: str
    name: str | None = None  # from inline fragment
    nameOverride: str | None = None  # from inline fragment
    accountDescription: str | None = None  # from inline fragment


class BMEnvelope(_GraphQLBase):
    id: str
    accountsDescription: str | None = None  # null on Cash Reserve envelopes
    orderPosition: int | None = None  # null on unordered envelopes
    purpose: BMPurposeRef | None = None  # null on orphan/cash envelopes
    accounts: list[BMAccount]


class BMSidebarData(_Base):
    envelopes: list[BMEnvelope]


class BMSidebarResponse(_Base):
    data: BMSidebarData


class BMLegalAccount(_GraphQLBase):
    taxationType: str


class BMLegalSubAccount(_GraphQLBase):
    id: str
    legacySubAccountId: int
    legalAccount: BMLegalAccount


class BMPurposeEnvelope(_GraphQLBase):
    id: str
    balance: int
    legalSubAccounts: list[BMLegalSubAccount]


class BMPurpose(_GraphQLBase):
    id: str
    name: str
    envelope: BMPurposeEnvelope


class BMPurposeData(_Base):
    purpose: BMPurpose


class BMPurposeResponse(_Base):
    data: BMPurposeData


class BMPerformanceHistoryItem(_GraphQLBase):
    date: str
    balance: int
    invested: int
    earned: int


class BMPerformanceHistory(_GraphQLBase):
    timeSeries: list[BMPerformanceHistoryItem]
    recencyDescription: str


class BMPerformanceTotalsInvesting(_GraphQLBase):
    earned: int


class BMPerformanceTotals(_GraphQLBase):
    investing: BMPerformanceTotalsInvesting


class BMPerformanceAccount(_GraphQLBase):
    """Performance data from GraphQL inline fragment.

    Fields beyond id come from `... on ManagedAccount` and are absent
    for other account types (CashAccount, CheckingAccount).
    """

    id: str
    legacyGoalId: int | None = None  # inline fragment
    balance: int | None = None  # inline fragment
    performanceHistory: BMPerformanceHistory | None = None  # inline fragment
    performanceTotals: BMPerformanceTotals | None = None  # inline fragment


class BMPerformanceData(_Base):
    account: BMPerformanceAccount | None = None  # null when account not found


class BMPerformanceResponse(_Base):
    data: BMPerformanceData


class BMSecurityGroup(_GraphQLBase):
    name: str
    targetWeight: float


class BMSecurity(_GraphQLBase):
    """Security from GraphQL — symbol/name come from inline fragment."""

    symbol: str | None = None  # from `... on SecurityFund` fragment
    name: str | None = None  # from `... on SecurityFund` fragment


class BMFinancialSecurity(_GraphQLBase):
    name: str | None = None  # sometimes absent in API response
    symbol: str | None = None  # sometimes absent in API response


class BMSecurityPosition(_GraphQLBase):
    amount: int
    shares: float
    security: BMSecurity
    financialSecurity: BMFinancialSecurity


class BMSecurityGroupPosition(_GraphQLBase):
    amount: int
    currentWeight: float
    securityGroup: BMSecurityGroup
    securityPositions: list[BMSecurityPosition]


class BMHoldingsAccount(_GraphQLBase):
    """Holdings from GraphQL inline fragment.

    securityGroupPositions comes from `... on ManagedAccount`.
    """

    id: str
    securityGroupPositions: list[BMSecurityGroupPosition] | None = None  # inline fragment


class BMHoldingsData(_Base):
    account: BMHoldingsAccount | None = None  # null when account not found


class BMHoldingsResponse(_Base):
    data: BMHoldingsData


# ── Ally ──────────────────────────────────────────────────────────────
# Only one response format in practice (transfer-accounts endpoint).
# External accounts (externalAccountIndicator=true) are missing nickname
# and currentBalance, but we skip them before field access. Internal
# accounts always have all fields.
#
# We validate after filtering out external accounts, so all fields are
# required. The AllyAccount model represents an internal Ally account.


class AllyDomainDetails(_Base):
    accountNickname: str
    externalAccountIndicator: bool
    accountId: str


class AllyAccount(_Base):
    """Internal Ally bank account. External accounts are filtered before validation."""

    accountNumberPvtEncrypt: str
    accountStatus: str
    accountType: str
    currentBalance: float
    nickname: str
    domainDetails: AllyDomainDetails


class AllyAccountsResponse(_Base):
    accounts: list[AllyAccount]


class AllyTransaction(_Base):
    transactionPostingDate: str
    transactionAmountPvtEncrypt: float
    transactionDescription: str
    transactionType: str


# ── Wealthfront ────────────────────────────────────────────────────────
# All fields always present in real data for funded accounts.
# Transfers endpoint currently returns errors — not modeled here.


class WFAccountValueBreakdown(_Base):
    name: str
    label: str
    value: float
    formattedValue: str


class WFAccountValueSummary(_Base):
    totalValue: float
    formattedTotalValue: str
    breakdown: list[WFAccountValueBreakdown]


class WFOverview(_Base):
    type: str
    accountId: str
    state: str
    accountType: str
    accountTypeDisplayName: str
    accountDisplayName: str
    accountValueSummary: WFAccountValueSummary
    advisoryFee: float
    flavor: str
    needsReview: bool


class WFOverviewsResponse(_Base):
    overviews: list[WFOverview]


class WFHistoryEntry(_Base):
    date: str
    marketValue: float
    sumNetDeposits: float
    marketOpen: bool
    timeWeightedReturn: float


class WFPerformanceResponse(_Base):
    accountId: str
    startDate: str
    endDate: str
    annualReturn: float
    numYears: float
    historyList: list[WFHistoryEntry]


class WFOpenLot(_Base):
    openDate: str
    symbol: str
    quantity: float
    costBasis: float
    unrealizedGainLoss: float
    currentValue: float


class WFOpenLotsResponse(_Base):
    openLotForDisplayList: list[WFOpenLot]


class WFTransfer(_Base):
    type: str
    amount: str
    created_at: str
    initiator_name: str | None = None  # absent on some transfer types
    class_type: str | None = None  # absent on some transfer types


class WFTransfersCompleted(_Base):
    completed_transfers: list[WFTransfer]


class WFTransfersWrapper(_Base):
    transfers: WFTransfersCompleted


# ── Chase ──────────────────────────────────────────────────────────────
# Network log entries have variable fields (not all requests have bodies).
# But parsed API responses (DDA detail, transactions, etc.) are always
# complete — every field is present.


class CHNetworkLogEntry(_Base):
    """A single captured network request/response in a Chase network log.

    Fields vary per entry — not all requests have response bodies,
    request bodies, etc. This is the raw extension capture format.
    """

    type: str | None = None
    url: str | None = None
    method: str | None = None
    status: int | None = None
    contentType: str | None = None
    requestBody: str | None = None
    requestHeaders: dict[str, str] | None = None
    responseBody: dict[str, object] | None = None
    responseSize: int | None = None
    duration: int | None = None
    timestamp: str | None = None


class CHNetworkLog(_Base):
    """Top-level structure of a Chase network log file."""

    institution: str
    entries: list[CHNetworkLogEntry]


class CHActivityAccount(_Base):
    """Account entry from the activity/options/list cache."""

    id: int
    mask: str
    nickname: str
    categoryType: str
    accountType: str


class CHActivityOptionsResponse(_Base):
    """Response body from /activity/options/list (embedded in dashboard cache)."""

    code: str
    accounts: list[CHActivityAccount]


class CHDashboardCacheEntry(_Base):
    """A single entry in the dashboard module list cache array."""

    url: str
    request: dict[str, object]
    response: dict[str, object]  # validated per-entry based on URL
    usage: str


class CHDashboardResponse(_Base):
    """Response body from /dashboard/module/list."""

    code: str
    modules: list[str]
    cache: list[CHDashboardCacheEntry]


class CHDdaDetail(_Base):
    """The nested 'detail' object inside a DDA account detail response."""

    detailType: str
    available: float
    presentBalance: float
    interestRate: float
    ytdInterest: float
    openDate: str
    asOf: str
    extendedAccountStatus: str


class CHDdaDetailResponse(_Base):
    """Response body from /account/detail/dda/list."""

    accountId: int
    nickname: str
    mask: str
    nonInterestBearing: bool
    detail: CHDdaDetail


class CHTransaction(_Base):
    """A single transaction entry from the etu-dda-transactions response."""

    transactionIdentifier: str
    transactionAmount: float
    transactionDate: str
    transactionPostDate: str
    transactionDescription: str
    runningLedgerBalanceAmount: float
    creditDebitCode: str
    pendingTransactionIndicator: bool
    etuStdTransactionTypeName: str
    etuStdTransactionGroupName: str
    etuStdExpenseCategoryCode: str
    etuStdExpenseCategoryName: str
    accountIdentifier: str


class CHTransactionsResponse(_Base):
    """Response body from the etu-dda-transactions endpoint."""

    moreRecordsIndicator: bool
    scrollKeyPageOffsetRecordIdentifier: str | None = None  # absent when no more pages
    sourceSystemName: str
    transactions: list[CHTransaction]


class CHCardReward(_Base):
    """A single card entry in the cardRewardsSummary list.

    memberStatus is only present on co-branded cards (e.g. Southwest).
    """

    accountId: int
    mask: str
    cardType: str
    rewardsType: str
    balance: int
    currentRewardsBalance: int
    nickname: str
    memberStatus: str | None = None  # only on co-branded cards (e.g. Southwest)


class CHCardRewardsResponse(_Base):
    """Response body from the rewards summary endpoint."""

    code: str
    cardRewardsSummary: list[CHCardReward]


class CHInvestMoneyField(_Base):
    """Chase investment money fields wrap the amount in `baseValueAmount`."""

    baseValueAmount: float = 0.0


class CHInvestmentPositionsSummary(_Base):
    """Aggregate fields from positionsSummary. Many optional — Chase omits
    them for accounts with no activity."""

    asOfDate: str | None = None
    totalMarketValueAmount: float = 0.0
    totalCashAndSweepAmount: float = 0.0
    totalTradedCostAmount: float = 0.0
    totalUnrealizedGainLossAmount: float = 0.0
    totalUnrealizedGainLossPercent: float = 0.0
    investmentAccountTypeNames: list[str] = []


class CHInvestmentPosition(_Base):
    """One holding inside a `positions` response."""

    instrumentShortName: str | None = None
    instrumentLongName: str | None = None
    assetCategoryName: str | None = None
    marketValue: CHInvestMoneyField | None = None
    tradedUnitQuantity: float = 0.0
    positionDate: str | None = None
    securityIdDetail: dict[str, object] | None = None


class CHInvestmentPositionsResponse(_Base):
    """Response body from digital-investment-positions/v2/positions."""

    positionsSummary: CHInvestmentPositionsSummary = CHInvestmentPositionsSummary()
    positions: list[CHInvestmentPosition] = []


class CHInvestmentBalancePoint(_Base):
    """Balance on a single day or month from the investment balance history."""

    balanceAmount: float = 0.0
    balanceDate: str


class CHInvestmentDailyBalancesResponse(_Base):
    dailyBalanceDetails: list[CHInvestmentBalancePoint] = []


class CHInvestmentMonthlyBalancesResponse(_Base):
    monthlyBalanceDetails: list[CHInvestmentBalancePoint] = []


class CHAccountTileDetail(_Base):
    """tileDetail subobject on dashboard accountTiles[]. currentBalance is the
    statement balance for cards (positive = owed) and present balance for DDA;
    null on tiles like AUTOLEASE."""

    currentBalance: float | None = None
    availableBalance: float | None = None
    closed: bool = False
    asOf: str | None = None


class CHAccountTile(_Base):
    """One tile from /svc/rr/accounts/secure/v4/dashboard/tiles/list.accountTiles[].

    accountTileType discriminates: "CARD" | "DDA" | "AUTOLEASE" | etc.
    accountTileDetailType is the sub-type ("CHK", "SAV", "BAC" for cards, ...).
    cardType is only present on CARD tiles."""

    accountId: int
    mask: str
    nickname: str
    accountTileType: str
    accountTileDetailType: str | None = None
    cardType: str | None = None
    tileDetail: CHAccountTileDetail = CHAccountTileDetail()


class CHTilesListResponse(_Base):
    """Response body from dashboard/tiles/list — embedded in the cache
    of /svc/rl/accounts/l4/v1/app/data/list."""

    accountTiles: list[CHAccountTile] = []


class CHPortfolioAccountEntry(_Base):
    """An account entry from portfolio/account/options/list2."""

    accountId: int
    nickname: str | None = None
    mask: str | None = None
    accountCategoryType: str | None = None
    groupType: str | None = None
    detailType: str | None = None


class CHPortfolioOptionsResponse(_Base):
    """Response body from /portfolio/account/options/list2."""

    code: str | None = None
    accounts: list[CHPortfolioAccountEntry] = []


# ── Fidelity NetBenefits ─────────────────────────────────────────────
# planSummary endpoint returns monthly performance data for the 401k plan.


class FidelityMonth(_Base):
    month: str  # "Jul-2025"
    fromDate: str  # ISO datetime
    toDate: str  # ISO datetime
    returnValue: float  # monthly return percentage
    fromBalance: float  # balance at start of month


class FidelityAccountPerformance(_Base):
    ytdReturn: float
    ytdAsOf: str
    yearlyStart: str
    yearlyEnd: str


class FidelityPerformance(_Base):
    account: FidelityAccountPerformance
    months: list[FidelityMonth]
    hasAccountError: bool
    hasMonthsError: bool


class FidelityPlanSummaryResponse(_Base):
    performance: FidelityPerformance
