/**
 * Spending page chart — wraps CategoryChart with transaction fetching,
 * time range filtering, category_path drill-down, and recurring toggle.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Transaction, TimeRange } from '../api'
import { fetchTransactions } from '../api'
import { CategoryChart } from './CategoryChart'

const TIME_PRESETS = [
  { label: '3m', key: '3m' },
  { label: '6m', key: '6m' },
  { label: '1y', key: '1y' },
  { label: 'all', key: 'all' },
]

/** Extract the next path segment below a prefix */
function nextSegment(path: string, prefix: string | null): string | null {
  if (!prefix) {
    const slash = path.indexOf('/')
    return slash === -1 ? path : path.slice(0, slash)
  }
  if (!path.startsWith(prefix + '/') && path !== prefix) return null
  if (path === prefix) return path
  const rest = path.slice(prefix.length + 1)
  const slash = rest.indexOf('/')
  return slash === -1 ? rest : rest.slice(0, slash)
}

interface SpendingChartsProps {
  prefix: string | null
  onPrefixChange: (prefix: string | null) => void
  onBarClick?: (month: string, category: string) => void
  timeRange?: TimeRange
  timeKey: string
  onTimeKeyChange: (key: string) => void
  onRecurringClick?: () => void
  recurringActive?: boolean
  transactionFilter?: (t: Transaction) => boolean
}

export function SpendingCharts({
  prefix,
  onPrefixChange,
  timeRange,
  timeKey,
  onTimeKeyChange,
  onRecurringClick,
  recurringActive,
  transactionFilter,
}: SpendingChartsProps) {
  const [allTxns, setAllTxns] = useState<Transaction[]>([])

  useEffect(() => {
    fetchTransactions({ limit: 10000, hideTransfers: true }).then(setAllTxns)
  }, [])

  // Filter transactions
  const filtered = useMemo(() => {
    let txns = allTxns.filter((t) => {
      if (t.amount >= 0) return false
      const path = t.category_path ?? ''
      if (path.startsWith('capital')) return false
      if (timeRange?.start && t.date < timeRange.start) return false
      if (timeRange?.end && t.date > timeRange.end) return false
      if (prefix) {
        if (path !== prefix && !path.startsWith(prefix + '/')) return false
      }
      return true
    })
    if (transactionFilter) txns = txns.filter(transactionFilter)
    return txns
  }, [allTxns, timeRange, prefix, transactionFilter])

  // Group by next category_path segment below prefix
  const groupFn = useCallback((t: Transaction) => {
    const path = t.category_path ?? 'uncategorized'
    return nextSegment(path, prefix)
  }, [prefix])

  // Breadcrumbs
  const segments = prefix ? prefix.split('/') : []
  const breadcrumbs = [
    { label: 'spending', onClick: () => onPrefixChange(null) },
    ...segments.map((seg, i) => ({
      label: seg,
      onClick: () => onPrefixChange(segments.slice(0, i + 1).join('/')),
    })),
  ]

  const handleCategoryClick = useCallback((category: string) => {
    const childPrefix = prefix ? `${prefix}/${category}` : category
    onPrefixChange(childPrefix)
  }, [prefix, onPrefixChange])

  if (allTxns.length === 0) return null

  return (
    <CategoryChart
      transactions={filtered}
      groupFn={groupFn}
      onCategoryClick={handleCategoryClick}
      breadcrumbs={breadcrumbs}
      headerControls={
        <>
          {onRecurringClick && (
            <button
              className={`toggle-btn ${recurringActive ? 'active' : ''}`}
              onClick={onRecurringClick}
            >recurring</button>
          )}
          <div className="time-presets">
            {TIME_PRESETS.map((p) => (
              <button
                key={p.key}
                className={`time-preset-btn ${timeKey === p.key ? 'active' : ''}`}
                onClick={() => onTimeKeyChange(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </>
      }
    />
  )
}
