import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Account, Transaction, TimeRange } from '../api'
import { fetchAccounts } from '../api'
import { SpendingCharts } from '../components/SpendingCharts'
import { TransactionTable } from '../components/TransactionTable'
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
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedAccount, setSelectedAccount] = useState<string | undefined>()
  const [refreshKey, setRefreshKey] = useState(0)
  const [suggestionsKey, setSuggestionsKey] = useState(0)
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
  }, [refreshKey])

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

  const handleReclassifyRequested = useCallback(() => {
    // Poll for new suggestions after reclassify (takes ~60-90s)
    const polls = [5000, 15000, 30000, 60000, 90000]
    polls.forEach((ms) => setTimeout(() => setSuggestionsKey((k) => k + 1), ms))
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
      <SpendingCharts
        key={refreshKey}
        prefix={prefix}
        onPrefixChange={handlePrefixChange}
        onBarClick={handleBarClick}
        timeRange={timeRange}
        timeKey={timeKey}
        onTimeKeyChange={setTimeKey}
      />
      <SuggestionReview key={`sug-${suggestionsKey}`} onRulesChanged={handleRulesChanged} />
      <TransactionTable
        key={`txn-${refreshKey}`}
        accounts={accounts}
        accountId={selectedAccount}
        onAccountChange={setSelectedAccount}
        filterFn={filterFn}
        filterLabel={filterLabel}
        onClearFilter={clearFilter}
        onReclassifyRequested={handleReclassifyRequested}
      />
    </>
  )
}
