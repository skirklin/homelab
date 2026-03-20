import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Account, MonthSummary, Transaction } from '../api'
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
  const [refreshKey, setRefreshKey] = useState(0)
  const [searchParams, setSearchParams] = useSearchParams()
  const prefix = searchParams.get('category') || null
  const monthFilter = searchParams.get('month') || null

  const setPrefix = useCallback((newPrefix: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (newPrefix) next.set('category', newPrefix)
      else next.delete('category')
      next.delete('month')
      return next
    })
  }, [setSearchParams])

  useEffect(() => {
    fetchAccounts().then(setAccounts)
    fetchSpendingByMonth().then(setMonths)
  }, [refreshKey])

  const handlePrefixChange = useCallback((newPrefix: string | null) => {
    setPrefix(newPrefix)
  }, [setPrefix])

  const handleBarClick = useCallback((_month: string, category: string) => {
    const childPrefix = prefix ? `${prefix}/${category}` : category
    setPrefix(childPrefix)
  }, [prefix, setPrefix])

  const clearFilter = useCallback(() => {
    setSearchParams({})
  }, [setSearchParams])

  const handleRulesChanged = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  const filterFn = useMemo(() => {
    if (!prefix && !monthFilter) return undefined
    return (t: Transaction) => {
      if (monthFilter && !t.date.startsWith(monthFilter)) return false
      if (prefix) {
        if (prefix === 'Uncategorized') {
          if (t.category_path) return false
        } else {
          const path = t.category_path ?? ''
          if (path !== prefix && !path.startsWith(prefix + '/')) return false
        }
      }
      return true
    }
  }, [prefix, monthFilter])

  const filterLabel = [monthFilter, prefix].filter(Boolean).join(' / ') || undefined

  return (
    <>
      <SummaryCards months={months} />
      <SpendingCharts
        key={refreshKey}
        prefix={prefix}
        onPrefixChange={handlePrefixChange}
        onBarClick={handleBarClick}
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
