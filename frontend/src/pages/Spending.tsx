import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Account, MonthSummary, Transaction, TimeRange } from '../api'
import { fetchAccounts, fetchSpendingByMonth } from '../api'
import { SpendingCharts } from '../components/SpendingCharts'
import { TransactionTable } from '../components/TransactionTable'
import { SuggestionReview } from '../components/SuggestionReview'

const fmtDollar = (v: number) =>
  `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`

function getCurrentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function getPrevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

function monthsAgo(n: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

const TIME_PRESETS: { label: string; key: string; range: TimeRange }[] = [
  { label: '3m', key: '3m', range: { start: monthsAgo(3) } },
  { label: '6m', key: '6m', range: { start: monthsAgo(6) } },
  { label: '1y', key: '1y', range: { start: monthsAgo(12) } },
  { label: 'all', key: 'all', range: {} },
]

function SummaryCards({ months }: { months: MonthSummary[] }) {
  if (months.length === 0) return null

  const currentMonth = getCurrentMonth()
  const prevMonth = getPrevMonth(currentMonth)

  const thisMonthSpending = months.find((m) => m.month === currentMonth)?.spending ?? 0
  const lastMonthSpending = months.find((m) => m.month === prevMonth)?.spending ?? 0

  const changeAbs = thisMonthSpending - lastMonthSpending
  const changePct = lastMonthSpending !== 0 ? (changeAbs / lastMonthSpending) * 100 : 0
  const changeIsGood = changeAbs <= 0

  const sortedMonths = [...months].sort((a, b) => b.month.localeCompare(a.month))
  const completeMonths = sortedMonths.filter((m) => m.month < currentMonth)
  const recent3 = completeMonths.slice(0, 3)
  const avg3 = recent3.length > 0
    ? recent3.reduce((s, m) => s + m.spending, 0) / recent3.length
    : 0

  return (
    <div className="summary-cards">
      <div className="summary-card">
        <span className="summary-card-label">this month</span>
        <span className="summary-card-value negative">{fmtDollar(thisMonthSpending)}</span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">last month</span>
        <span className="summary-card-value negative">{fmtDollar(lastMonthSpending)}</span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">month-over-month</span>
        <span className={`summary-card-value ${changeIsGood ? 'positive' : 'negative'}`}>
          {changeAbs <= 0 ? '-' : '+'}{fmtDollar(Math.abs(changeAbs))}
        </span>
        <span className={`summary-card-change ${changeIsGood ? 'positive' : 'negative'}`}>
          {fmtPct(changePct)}
        </span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">3-month avg</span>
        <span className="summary-card-value negative">{fmtDollar(avg3)}</span>
      </div>
    </div>
  )
}

export function Spending() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedAccount, setSelectedAccount] = useState<string | undefined>()
  const [months, setMonths] = useState<MonthSummary[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [searchParams, setSearchParams] = useSearchParams()

  const prefix = searchParams.get('category') || null
  const timeKey = searchParams.get('time') || '1y'
  const timeRange = useMemo(
    () => TIME_PRESETS.find((p) => p.key === timeKey)?.range ?? {},
    [timeKey],
  )

  const setPrefix = useCallback((newPrefix: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (newPrefix) next.set('category', newPrefix)
      else next.delete('category')
      return next
    })
  }, [setSearchParams])

  const setTimeKey = useCallback((key: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (key === '1y') next.delete('time')
      else next.set('time', key)
      return next
    })
  }, [setSearchParams])

  useEffect(() => {
    fetchAccounts().then(setAccounts)
    fetchSpendingByMonth(timeRange).then(setMonths)
  }, [refreshKey, timeRange])

  const handlePrefixChange = useCallback((newPrefix: string | null) => {
    setPrefix(newPrefix)
  }, [setPrefix])

  const handleBarClick = useCallback((_month: string, category: string) => {
    const childPrefix = prefix ? `${prefix}/${category}` : category
    setPrefix(childPrefix)
  }, [prefix, setPrefix])

  const clearFilter = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('category')
      return next
    })
  }, [setSearchParams])

  const handleRulesChanged = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  const filterFn = useMemo(() => {
    if (!prefix) return undefined
    return (t: Transaction) => {
      if (prefix === 'Uncategorized') {
        if (t.category_path) return false
      } else {
        const path = t.category_path ?? ''
        if (path !== prefix && !path.startsWith(prefix + '/')) return false
      }
      return true
    }
  }, [prefix])

  const filterLabel = prefix || undefined

  return (
    <>
      <div className="spending-top-bar">
        <SummaryCards months={months} />
        <div className="time-presets">
          {TIME_PRESETS.map((p) => (
            <button
              key={p.key}
              className={`time-preset-btn ${timeKey === p.key ? 'active' : ''}`}
              onClick={() => setTimeKey(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <SpendingCharts
        key={refreshKey}
        prefix={prefix}
        onPrefixChange={handlePrefixChange}
        onBarClick={handleBarClick}
        timeRange={timeRange}
      />
      <SuggestionReview onRulesChanged={handleRulesChanged} />
      <TransactionTable
        key={`txn-${refreshKey}`}
        accounts={accounts}
        accountId={selectedAccount}
        onAccountChange={setSelectedAccount}
        filterFn={filterFn}
        filterLabel={filterLabel}
        onClearFilter={clearFilter}
      />
    </>
  )
}
