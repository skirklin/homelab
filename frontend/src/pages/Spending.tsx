import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Account, TimeRange } from '../api'
import { fetchAccounts } from '../api'
import { SpendingCharts } from '../components/SpendingCharts'
import { SuggestionReview } from '../components/SuggestionReview'
import { RecurringPatterns } from '../components/RecurringPatterns'

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

type Tab = 'spending' | 'recurring'

export function Spending() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [suggestionsKey, setSuggestionsKey] = useState(0)
  const [searchParams, setSearchParams] = useSearchParams()

  const prefix = searchParams.get('category') || null
  const timeKey = searchParams.get('time') || '1y'
  const activeTab = (searchParams.get('tab') as Tab) || 'spending'
  const timeRange = useMemo(
    () => TIME_PRESETS.find((p) => p.key === timeKey)?.range ?? {},
    [timeKey],
  )

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

  const setTab = useCallback((tab: Tab) => {
    setParam('tab', tab === 'spending' ? null : tab)
  }, [setParam])

  const handleBarClick = useCallback((_month: string, category: string) => {
    const childPrefix = prefix ? `${prefix}/${category}` : category
    setPrefix(childPrefix)
  }, [prefix, setPrefix])

  const handleRulesChanged = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  const handleReclassifyRequested = useCallback(() => {
    const polls = [5000, 15000, 30000, 60000, 90000]
    polls.forEach((ms) => setTimeout(() => setSuggestionsKey((k) => k + 1), ms))
  }, [])

  return (
    <>
      <div className="spending-tabs">
        <button
          className={`spending-tab ${activeTab === 'spending' ? 'active' : ''}`}
          onClick={() => setTab('spending')}
        >
          spending
        </button>
        <button
          className={`spending-tab ${activeTab === 'recurring' ? 'active' : ''}`}
          onClick={() => setTab('recurring')}
        >
          recurring
        </button>
      </div>

      {activeTab === 'spending' && (
        <>
          <SpendingCharts
            key={refreshKey}
            prefix={prefix}
            onPrefixChange={setPrefix}
            onBarClick={handleBarClick}
            timeRange={timeRange}
            timeKey={timeKey}
            onTimeKeyChange={setTimeKey}
          />
          <SuggestionReview key={`sug-${suggestionsKey}`} onRulesChanged={handleRulesChanged} />
        </>
      )}

      {activeTab === 'recurring' && (
        <RecurringPatterns />
      )}
    </>
  )
}
