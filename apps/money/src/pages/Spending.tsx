import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUrlParam } from '@kirkl/shared'
import type { RecurringPattern, TimeRange, Transaction } from '../api'
import { fetchRecurring } from '../api'
import { SpendingCharts } from '../components/SpendingCharts'
import { SuggestionReview } from '../components/SuggestionReview'

function startOfMonthsAgo(n: number): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - n + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

const TIME_PRESETS: { label: string; key: string; range: TimeRange }[] = [
  { label: '3m', key: '3m', range: { start: startOfMonthsAgo(3) } },
  { label: '6m', key: '6m', range: { start: startOfMonthsAgo(6) } },
  { label: '1y', key: '1y', range: { start: startOfMonthsAgo(12) } },
  { label: 'all', key: 'all', range: {} },
]

export function Spending() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [recurringPatterns, setRecurringPatterns] = useState<RecurringPattern[]>([])

  const [prefix, setPrefix] = useUrlParam<string | null>('category', {
    parse: (raw) => raw || null,
    serialize: (v) => v,
    default: null,
  })
  const [timeKey, setTimeKey] = useUrlParam<string>('time', {
    parse: (raw) => raw || '1y',
    serialize: (v) => (v === '1y' ? null : v),
    default: '1y',
  })
  const [showRecurring, setShowRecurring] = useUrlParam<boolean>('recurring', {
    parse: (raw) => raw === '1',
    serialize: (v) => (v ? '1' : null),
    default: false,
  })
  const timeRange = useMemo(
    () => TIME_PRESETS.find((p) => p.key === timeKey)?.range ?? {},
    [timeKey],
  )

  useEffect(() => {
    fetchRecurring().then(setRecurringPatterns)
  }, [])

  const recurringMatchers = useMemo(() => {
    return recurringPatterns
      .filter((p) => p.status === 'confirmed' && p.pattern)
      .map((p) => {
        // Convert SQL LIKE pattern to a regex
        const escaped = p.pattern!
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/%/g, '.*')
        return new RegExp(`^${escaped}$`, 'i')
      })
  }, [recurringPatterns])

  const transactionFilter = useMemo(() => {
    if (!showRecurring) return undefined
    return (t: Transaction) => {
      const desc = t.description ?? ''
      return recurringMatchers.some((re) => re.test(desc))
    }
  }, [showRecurring, recurringMatchers])

  const toggleRecurring = useCallback(() => {
    setShowRecurring(!showRecurring)
  }, [setShowRecurring, showRecurring])

  const handleBarClick = useCallback((_month: string, category: string) => {
    const childPrefix = prefix ? `${prefix}/${category}` : category
    setPrefix(childPrefix)
  }, [prefix, setPrefix])

  const handleRulesChanged = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  return (
    <>
      <SpendingCharts
        key={refreshKey}
        prefix={prefix}
        onPrefixChange={setPrefix}
        onBarClick={handleBarClick}
        timeRange={timeRange}
        timeKey={timeKey}
        onTimeKeyChange={setTimeKey}
        onRecurringClick={toggleRecurring}
        recurringActive={showRecurring}
        transactionFilter={transactionFilter}
      />
      <SuggestionReview onRulesChanged={handleRulesChanged} />
    </>
  )
}
