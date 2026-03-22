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


# ── Betterment ────────────────────────────────────────────────────────


class BMPurposeRef(TypedDict):
    id: str
    name: str
    __typename: str


class _BMAccountRequired(TypedDict):
    __typename: str
    id: str


class BMAccount(_BMAccountRequired, total=False):
    name: str
    nameOverride: str | None
    accountDescription: str


class BMEnvelope(TypedDict):
    id: str
    accountsDescription: str
    orderPosition: int | None
    purpose: BMPurposeRef | None
    accounts: list[BMAccount]
    __typename: str


class BMSidebarData(TypedDict):
    envelopes: list[BMEnvelope]


class BMSidebarResponse(TypedDict):
    data: BMSidebarData


class BMLegalAccount(TypedDict):
    taxationType: str
    __typename: str


class BMLegalSubAccount(TypedDict):
    id: str
    legacySubAccountId: int
    legalAccount: BMLegalAccount
    __typename: str


class BMPurposeEnvelope(TypedDict):
    id: str
    balance: int
    legalSubAccounts: list[BMLegalSubAccount]
    __typename: str


class BMPurpose(TypedDict):
    id: str
    name: str
    envelope: BMPurposeEnvelope
    __typename: str


class BMPurposeData(TypedDict):
    purpose: BMPurpose


class BMPurposeResponse(TypedDict):
    data: BMPurposeData


class BMPerformanceHistoryItem(TypedDict):
    date: str
    balance: int
    invested: int
    earned: int
    __typename: str


class BMPerformanceHistory(TypedDict):
    timeSeries: list[BMPerformanceHistoryItem]
    recencyDescription: str
    __typename: str


class BMPerformanceTotalsInvesting(TypedDict):
    earned: int
    __typename: str


class BMPerformanceTotals(TypedDict):
    investing: BMPerformanceTotalsInvesting
    __typename: str


class BMPerformanceAccount(TypedDict, total=False):
    id: str
    legacyGoalId: int
    balance: int
    performanceHistory: BMPerformanceHistory
    performanceTotals: BMPerformanceTotals
    __typename: str


class BMPerformanceData(TypedDict):
    account: BMPerformanceAccount | None


class BMPerformanceResponse(TypedDict):
    data: BMPerformanceData


class BMSecurityGroup(TypedDict):
    name: str
    targetWeight: float
    __typename: str


class BMSecurity(TypedDict, total=False):
    symbol: str
    name: str
    __typename: str


class BMFinancialSecurity(TypedDict, total=False):
    name: str
    symbol: str
    __typename: str


class BMSecurityPosition(TypedDict):
    amount: int
    shares: float
    security: BMSecurity
    financialSecurity: BMFinancialSecurity
    __typename: str


class BMSecurityGroupPosition(TypedDict):
    amount: int
    currentWeight: float
    securityGroup: BMSecurityGroup
    securityPositions: list[BMSecurityPosition]
    __typename: str


class BMHoldingsAccount(TypedDict, total=False):
    id: str
    securityGroupPositions: list[BMSecurityGroupPosition]
    __typename: str


class BMHoldingsData(TypedDict):
    account: BMHoldingsAccount | None


class BMHoldingsResponse(TypedDict):
    data: BMHoldingsData


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


# ── Wealthfront ────────────────────────────────────────────────────────


class WFAccountValueBreakdown(TypedDict):
    name: str
    label: str
    value: float
    formattedValue: str


class WFAccountValueSummary(TypedDict):
    totalValue: float
    formattedTotalValue: str
    breakdown: list[WFAccountValueBreakdown]


class WFOverview(TypedDict, total=False):
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


class WFOverviewsResponse(TypedDict):
    overviews: list[WFOverview]


class WFHistoryEntry(TypedDict, total=False):
    date: str
    marketValue: float
    sumNetDeposits: float
    marketOpen: bool
    timeWeightedReturn: float


class WFPerformanceResponse(TypedDict, total=False):
    accountId: str
    startDate: str
    endDate: str
    annualReturn: float
    numYears: float
    historyList: list[WFHistoryEntry]


class WFOpenLot(TypedDict, total=False):
    openDate: str
    symbol: str
    quantity: float
    costBasis: float
    unrealizedGainLoss: float
    currentValue: float


class WFOpenLotsResponse(TypedDict, total=False):
    openLotForDisplayList: list[WFOpenLot]


class WFTransfer(TypedDict, total=False):
    type: str
    amount: str
    created_at: str
    initiator_name: str
    class_type: str


class WFTransfersCompleted(TypedDict, total=False):
    completed_transfers: list[WFTransfer]


class WFTransfersWrapper(TypedDict, total=False):
    transfers: WFTransfersCompleted


# ── Chase ──────────────────────────────────────────────────────────────


class CHNetworkLogEntry(TypedDict, total=False):
    """A single captured network request/response in a Chase network log."""

    type: str
    url: str
    method: str
    status: int
    contentType: str
    requestBody: str | None
    requestHeaders: dict[str, str]
    responseBody: dict[str, object] | None
    responseSize: int | None
    duration: int
    timestamp: str


class CHNetworkLog(TypedDict):
    """Top-level structure of a Chase network log file."""

    institution: str
    entries: list[CHNetworkLogEntry]


class CHActivityAccount(TypedDict, total=False):
    """Account entry from the activity/options/list cache."""

    id: int
    mask: str
    nickname: str
    categoryType: str
    accountType: str


class CHActivityOptionsResponse(TypedDict, total=False):
    """Response body from /activity/options/list (embedded in dashboard cache)."""

    code: str
    accounts: list[CHActivityAccount]


class CHDashboardCacheEntry(TypedDict, total=False):
    """A single entry in the dashboard module list cache array."""

    url: str
    request: dict[str, object]
    response: CHActivityOptionsResponse
    usage: str


class CHDashboardResponse(TypedDict, total=False):
    """Response body from /dashboard/module/list."""

    code: str
    modules: list[str]
    cache: list[CHDashboardCacheEntry]


class CHDdaDetail(TypedDict, total=False):
    """The nested 'detail' object inside a DDA account detail response."""

    detailType: str
    available: float
    presentBalance: float
    interestRate: float
    ytdInterest: float
    openDate: str
    asOf: str
    extendedAccountStatus: str


class CHDdaDetailResponse(TypedDict, total=False):
    """Response body from /account/detail/dda/list."""

    accountId: int
    nickname: str
    mask: str
    nonInterestBearing: bool
    detail: CHDdaDetail


class CHTransaction(TypedDict, total=False):
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


class CHTransactionsResponse(TypedDict, total=False):
    """Response body from the etu-dda-transactions endpoint."""

    moreRecordsIndicator: bool
    scrollKeyPageOffsetRecordIdentifier: str
    sourceSystemName: str
    transactions: list[CHTransaction]


class CHCardReward(TypedDict, total=False):
    """A single card entry in the cardRewardsSummary list."""

    accountId: int
    mask: str
    cardType: str
    rewardsType: str
    balance: int
    currentRewardsBalance: int
    nickname: str
    memberStatus: str


class CHCardRewardsResponse(TypedDict, total=False):
    """Response body from the rewards summary endpoint."""

    code: str
    cardRewardsSummary: list[CHCardReward]
