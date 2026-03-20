import { useCallback, useEffect, useMemo, useState } from 'react'
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

  // drillCategory: which top-level category the chart is drilled into (null = top level)
  // txnFilter: what the transaction table filters by (month, category path prefix)
  const [drillCategory, setDrillCategory] = useState<string | null>(null)
  const [txnFilter, setTxnFilter] = useState<{ month?: string; categoryPrefix?: string }>({})

  useEffect(() => {
    fetchAccounts().then(setAccounts)
    fetchSpendingByMonth().then(setMonths)
  }, [refreshKey])

  const handleCategoryChange = useCallback((category: string | null) => {
    setDrillCategory(category)
    // When drilling into a category, also filter transactions to it
    setTxnFilter(category ? { categoryPrefix: category } : {})
  }, [])

  const handleSubcategoryClick = useCallback((subcategory: string) => {
    // Filter transactions to a specific subcategory within the drilled-in group
    // e.g. drillCategory="Housing", subcategory="Rent" → filter to "Housing/Rent"
    setTxnFilter((prev) => {
      const fullPath = drillCategory ? `${drillCategory}/${subcategory}` : subcategory
      // Toggle off if already selected
      if (prev.categoryPrefix === fullPath) {
        return drillCategory ? { categoryPrefix: drillCategory } : {}
      }
      return { ...prev, categoryPrefix: fullPath }
    })
  }, [drillCategory])

  const handleBarClick = useCallback((month: string, category: string) => {
    setTxnFilter((prev) => {
      const prefix = drillCategory ? `${drillCategory}/${category}` : category
      if (prev.month === month && prev.categoryPrefix === prefix) return {}
      return { month, categoryPrefix: prefix }
    })
  }, [drillCategory])

  const clearFilter = useCallback(() => {
    setTxnFilter({})
    setDrillCategory(null)
  }, [])

  const handleRulesChanged = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  const filterFn = useMemo(() => {
    if (!txnFilter.month && !txnFilter.categoryPrefix) return undefined
    return (t: Transaction) => {
      if (txnFilter.month && !t.date.startsWith(txnFilter.month)) return false
      if (txnFilter.categoryPrefix) {
        if (txnFilter.categoryPrefix === 'Uncategorized') {
          if (t.category_path) return false
        } else {
          const path = t.category_path ?? ''
          // Match if the path starts with the prefix (or equals it)
          if (path !== txnFilter.categoryPrefix
            && !path.startsWith(txnFilter.categoryPrefix + '/')) return false
        }
      }
      return true
    }
  }, [txnFilter])

  const filterLabel = [txnFilter.month, txnFilter.categoryPrefix].filter(Boolean).join(' / ') || undefined

  return (
    <>
      <SummaryCards months={months} />
      <SpendingCharts
        key={refreshKey}
        selectedCategory={drillCategory}
        onCategoryChange={handleCategoryChange}
        onSubcategoryClick={handleSubcategoryClick}
        onBarClick={handleBarClick}
        activeSubcategory={txnFilter.categoryPrefix}
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
