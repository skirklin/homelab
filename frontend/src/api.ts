export interface Account {
  id: string
  name: string
  institution: string | null
  account_type: string
  external_id: string | null
  latest_balance: number | null
  balance_as_of: string | null
  total_invested: number | null
  total_earned: number | null
}

export interface BalancePoint {
  account_id: string
  account_name: string
  institution: string
  date: string
  balance: number
}

export interface NetWorthPoint {
  date: string
  net_worth: number
  invested: number | null
  earned: number | null
}

export interface PerformancePoint {
  account_id: string
  account_name: string
  institution: string
  account_type: string
  date: string
  balance: number
  invested: number | null
  earned: number | null
}

export interface Transaction {
  id: number
  date: string
  amount: number
  description: string | null
  category: string | null
  account_name: string
  institution: string
}

export interface MonthSummary {
  month: string
  income: number
  spending: number
  net: number
}

export interface CategorySummary {
  category: string
  total: number
  count: number
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export const fetchAccounts = () =>
  get<{ accounts: Account[] }>('/api/accounts').then((d) => d.accounts)

export const fetchBalances = (accountId?: string) =>
  get<{ balances: BalancePoint[] }>(
    accountId ? `/api/balances?account_id=${accountId}` : '/api/balances',
  ).then((d) => d.balances)

export const fetchNetWorthHistory = (start?: string, end?: string) => {
  const params = new URLSearchParams()
  if (start) params.set('start', start)
  if (end) params.set('end', end)
  const qs = params.toString()
  return get<{ series: NetWorthPoint[] }>(`/api/net-worth/history${qs ? `?${qs}` : ''}`).then(
    (d) => d.series,
  )
}

export const fetchPerformance = (opts?: { accountId?: string; institution?: string }) => {
  const params = new URLSearchParams()
  if (opts?.accountId) params.set('account_id', opts.accountId)
  if (opts?.institution) params.set('institution', opts.institution)
  const qs = params.toString()
  return get<{ series: PerformancePoint[] }>(`/api/performance${qs ? `?${qs}` : ''}`).then(
    (d) => d.series,
  )
}

export const fetchTransactions = (opts?: {
  search?: string
  accountId?: string
  start?: string
  end?: string
  hideTransfers?: boolean
  limit?: number
}) => {
  const params = new URLSearchParams()
  if (opts?.search) params.set('search', opts.search)
  if (opts?.accountId) params.set('account_id', opts.accountId)
  if (opts?.start) params.set('start', opts.start)
  if (opts?.end) params.set('end', opts.end)
  if (opts?.hideTransfers) params.set('hide_transfers', '1')
  if (opts?.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return get<{ transactions: Transaction[] }>(`/api/transactions${qs ? `?${qs}` : ''}`).then(
    (d) => d.transactions,
  )
}

export const fetchSpendingByMonth = () =>
  get<{ months: MonthSummary[] }>('/api/spending/summary?group_by=month').then((d) => d.months)

export const fetchSpendingByCategory = () =>
  get<{ categories: CategorySummary[] }>('/api/spending/summary?group_by=category').then(
    (d) => d.categories,
  )
