import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUrlParam, useUrlParams } from '@kirkl/shared'
import type { Transaction } from '../api'
import { fetchTransactions, reclassifyTransaction } from '../api'

const fmtDollar = (v: number) =>
  `${v < 0 ? '-' : '+'}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

const TIME_PRESETS = [
  { label: '1w', key: '1w', start: daysAgo(7) },
  { label: '1m', key: '1m', start: daysAgo(30) },
  { label: '3m', key: '3m', start: daysAgo(90) },
  { label: 'all', key: 'all', start: undefined },
]

type SortKey = 'date' | 'amount' | 'description' | 'category' | 'account'
type SortDir = 'asc' | 'desc'

const SORT_KEYS: SortKey[] = ['date', 'amount', 'description', 'category', 'account']
const DEFAULT_SORT_KEY: SortKey = 'date'
const DEFAULT_SORT_DIR: SortDir = 'desc'

interface SortState {
  sort: SortKey
  dir: SortDir
}

const SORT_SPEC = {
  sort: {
    parse: (raw: string | null): SortKey =>
      SORT_KEYS.includes(raw as SortKey) ? (raw as SortKey) : DEFAULT_SORT_KEY,
    serialize: (v: SortKey) => (v === DEFAULT_SORT_KEY ? null : v),
    default: DEFAULT_SORT_KEY,
  },
  dir: {
    parse: (raw: string | null): SortDir => (raw === 'asc' ? 'asc' : DEFAULT_SORT_DIR),
    serialize: (v: SortDir) => (v === DEFAULT_SORT_DIR ? null : v),
    default: DEFAULT_SORT_DIR,
  },
} as const

export function Transactions() {
  const [allTxns, setAllTxns] = useState<Transaction[]>([])
  const [reclassifyingId, setReclassifyingId] = useState<number | null>(null)
  const [reclassifyFeedback, setReclassifyFeedback] = useState('')

  // Search input: instant local state for typing feedback; URL lags by 250ms.
  const [urlSearch, setUrlSearch] = useUrlParam<string>('q', {
    parse: (raw) => raw ?? '',
    serialize: (v) => v || null,
    default: '',
    debounce: 250,
  })
  const [search, setSearchLocal] = useState(urlSearch)
  const setSearch = useCallback(
    (value: string) => {
      setSearchLocal(value)
      setUrlSearch(value)
    },
    [setUrlSearch],
  )

  const [timeKey, setTimeKey] = useUrlParam<string>('time', {
    parse: (raw) => raw || '1w',
    serialize: (v) => (v === '1w' ? null : v),
    default: '1w',
  })
  const preset = TIME_PRESETS.find((p) => p.key === timeKey) ?? TIME_PRESETS[0]
  // sort/dir are written together in handleSort (single user action mutates
  // both params) — useUrlParams writes both keys atomically in a single
  // history entry.
  const [{ sort: sortKey, dir: sortDir }, setSort] = useUrlParams<SortState>(SORT_SPEC)

  useEffect(() => {
    fetchTransactions({ limit: 10000 }).then(setAllTxns)
  }, [])

  const handleSort = (key: SortKey) => {
    let nextDir: SortDir
    if (sortKey === key) {
      nextDir = sortDir === 'asc' ? 'desc' : 'asc'
    } else {
      nextDir = key === 'amount' ? 'desc' : key === 'date' ? 'desc' : 'asc'
    }
    setSort({ sort: key, dir: nextDir })
  }

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return null
    return <span className="sort-indicator">{sortDir === 'asc' ? ' \u25B2' : ' \u25BC'}</span>
  }

  const filtered = useMemo(() => {
    let txns = allTxns

    // Time filter
    if (preset.start) {
      txns = txns.filter((t) => t.date >= preset.start!)
    }

    // Exclude capital
    txns = txns.filter((t) => {
      const path = t.category_path ?? ''
      return !path.startsWith('capital')
    })

    // Text search
    if (search) {
      const q = search.toLowerCase()
      txns = txns.filter(
        (t) =>
          (t.description ?? '').toLowerCase().includes(q) ||
          (t.category_path ?? '').toLowerCase().includes(q) ||
          t.account_name.toLowerCase().includes(q),
      )
    }

    // Sort
    const sorted = [...txns].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'date': cmp = a.date.localeCompare(b.date); break
        case 'amount': cmp = Math.abs(a.amount) - Math.abs(b.amount); break
        case 'description': cmp = (a.description ?? '').localeCompare(b.description ?? ''); break
        case 'category': cmp = (a.category_path ?? '').localeCompare(b.category_path ?? ''); break
        case 'account': cmp = a.account_name.localeCompare(b.account_name); break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

    return sorted
  }, [allTxns, preset, search, sortKey, sortDir])

  return (
    <>
      <div className="section-header">
        <h2>transactions</h2>
        <div className="controls">
          <input
            type="text"
            placeholder="search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="search-input"
          />
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
      </div>
      <div className="table-container" style={{ maxHeight: 'none' }}>
        <table className="txn-table">
          <thead>
            <tr>
              <th className="sortable" onClick={() => handleSort('date')}>
                date{sortIndicator('date')}
              </th>
              <th className="sortable" onClick={() => handleSort('description')}>
                description{sortIndicator('description')}
              </th>
              <th className="sortable" onClick={() => handleSort('category')}>
                category{sortIndicator('category')}
              </th>
              <th className="sortable" onClick={() => handleSort('account')}>
                account{sortIndicator('account')}
              </th>
              <th className="sortable right" onClick={() => handleSort('amount')}>
                amount{sortIndicator('amount')}
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => {
              const isReclassifying = reclassifyingId === t.id
              return (
                <tr key={t.id}>
                  <td className="date">{t.date}</td>
                  <td className="desc">{t.description}</td>
                  <td className="acct">{t.category_path ?? '—'}</td>
                  <td className="acct">
                    {t.institution ? `${t.institution} / ` : ''}{t.account_name}
                  </td>
                  <td className={`amount right ${t.amount >= 0 ? 'positive' : 'negative'}`}>
                    {fmtDollar(t.amount)}
                  </td>
                  <td className="cat-actions">
                    {isReclassifying ? (
                      <input
                        type="text"
                        className="reclassify-input"
                        placeholder="what's wrong?"
                        value={reclassifyFeedback}
                        onChange={(e) => setReclassifyFeedback(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && reclassifyFeedback) {
                            reclassifyTransaction(t.id, reclassifyFeedback)
                            setReclassifyingId(null)
                            setReclassifyFeedback('')
                          }
                          if (e.key === 'Escape') setReclassifyingId(null)
                        }}
                        autoFocus
                      />
                    ) : (
                      <button
                        className="reclassify-btn"
                        onClick={() => {
                          setReclassifyingId(t.id)
                          setReclassifyFeedback('')
                        }}
                      >?</button>
                    )}
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', opacity: 0.5, padding: '2rem' }}>
                  no transactions
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
