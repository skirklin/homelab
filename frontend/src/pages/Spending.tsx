import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Account, MonthSummary, Transaction } from '../api'
import { fetchAccounts, fetchSpendingByMonth } from '../api'
import { SpendingCharts } from '../components/SpendingCharts'
import { TransactionTable } from '../components/TransactionTable'

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

interface FilterState {
  month?: string
  category?: string
}

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
        <span className="summary-card-label">This Month</span>
        <span className="summary-card-value negative">{fmtDollar(thisMonthSpending)}</span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">Last Month</span>
        <span className="summary-card-value negative">{fmtDollar(lastMonthSpending)}</span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">Month-over-Month</span>
        <span className={`summary-card-value ${changeIsGood ? 'positive' : 'negative'}`}>
          {changeAbs <= 0 ? '-' : '+'}{fmtDollar(Math.abs(changeAbs))}
        </span>
        <span className={`summary-card-change ${changeIsGood ? 'positive' : 'negative'}`}>
          {fmtPct(changePct)}
        </span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">3-Month Avg</span>
        <span className="summary-card-value negative">{fmtDollar(avg3)}</span>
      </div>
    </div>
  )
}

export function Spending() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedAccount, setSelectedAccount] = useState<string | undefined>()
  const [months, setMonths] = useState<MonthSummary[]>([])
  const [filter, setFilter] = useState<FilterState>({})

  useEffect(() => {
    fetchAccounts().then(setAccounts)
    fetchSpendingByMonth().then(setMonths)
  }, [])

  const handleBarClick = useCallback((month: string, category: string) => {
    setFilter((prev) =>
      prev.month === month && prev.category === category ? {} : { month, category },
    )
  }, [])

  const handleCategoryChange = useCallback((category: string | null) => {
    setFilter(category ? { category } : {})
  }, [])

  const clearFilter = useCallback(() => setFilter({}), [])

  const filterFn = useMemo(() => {
    if (!filter.month && !filter.category) return undefined
    return (t: Transaction) => {
      if (filter.month && !t.date.startsWith(filter.month)) return false
      if (filter.category) {
        if (filter.category === 'Uncategorized') {
          if (t.category_path) return false
        } else {
          const path = t.category_path ?? ''
          const topLevel = path.split('/')[0]
          if (topLevel !== filter.category && path !== filter.category) return false
        }
      }
      return true
    }
  }, [filter])

  const filterLabel = [filter.month, filter.category].filter(Boolean).join(' / ') || undefined

  return (
    <>
      <SummaryCards months={months} />
      <SpendingCharts
        selectedCategory={filter.category ?? null}
        onCategoryChange={handleCategoryChange}
        onBarClick={handleBarClick}
      />
      <TransactionTable
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
