import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
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
  const [suggestionsKey, setSuggestionsKey] = useState(0)
  const [searchParams, setSearchParams] = useSearchParams()
  const [recurringPatterns, setRecurringPatterns] = useState<RecurringPattern[]>([])

  const prefix = searchParams.get('category') || null
  const timeKey = searchParams.get('time') || '1y'
  const showRecurring = searchParams.get('recurring') === '1'
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

  const setParam = useCallback((key: string, value: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }, [setSearchParams])

  const setPrefix = useCallback((newPrefix: string | null) => {
    setParam('category', newPrefix)
  }, [setParam])

  const setTimeKey = useCallback((key: string) => {
    setParam('time', key === '1y' ? null : key)
  }, [setParam])

  const toggleRecurring = useCallback(() => {
    setParam('recurring', showRecurring ? null : '1')
  }, [setParam, showRecurring])

  const handleBarClick = useCallback((_month: string, category: string) => {
    const childPrefix = prefix ? `${prefix}/${category}` : category
    setPrefix(childPrefix)
  }, [prefix, setPrefix])

  const handleRulesChanged = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  const _handleReclassifyRequested = useCallback(() => {
    const polls = [5000, 15000, 30000, 60000, 90000]
    polls.forEach((ms) => setTimeout(() => setSuggestionsKey((k) => k + 1), ms))
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
      <SuggestionReview key={`sug-${suggestionsKey}`} onRulesChanged={handleRulesChanged} />
    </>
  )
}
