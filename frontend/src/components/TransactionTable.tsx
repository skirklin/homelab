import { useEffect, useMemo, useState } from 'react'
import type { Account, Transaction } from '../api'
import { fetchTransactions } from '../api'

const fmtDollar = (v: number) =>
  `${v < 0 ? '-' : '+'}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type SortKey = 'date' | 'amount' | 'description' | 'category' | 'account'
type SortDir = 'asc' | 'desc'

interface Props {
  accounts?: Account[]
  accountId?: string
  onAccountChange?: (id: string | undefined) => void
  filterFn?: (t: Transaction) => boolean
  filterLabel?: string
  onClearFilter?: () => void
}

export function TransactionTable({
  accounts,
  accountId,
  onAccountChange,
  filterFn,
  filterLabel,
  onClearFilter,
}: Props) {
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([])
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [hideTransfers, setHideTransfers] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    fetchTransactions({
      accountId,
      hideTransfers,
      limit: 500,
    }).then(setAllTransactions)
  }, [accountId, hideTransfers])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      // Default sort direction: amount → desc (biggest first), others → asc
      setSortDir(key === 'amount' ? 'desc' : 'asc')
    }
  }

  const sorted = useMemo(() => {
    let result = allTransactions

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase()
      result = result.filter(
        (t) =>
          (t.description ?? '').toLowerCase().includes(q) ||
          (t.category ?? '').toLowerCase().includes(q) ||
          (t.category_path ?? '').toLowerCase().includes(q) ||
          t.account_name.toLowerCase().includes(q),
      )
    }

    if (filterFn) {
      result = result.filter(filterFn)
    }

    const sorted = [...result].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'date':
          cmp = a.date.localeCompare(b.date)
          break
        case 'amount':
          cmp = Math.abs(a.amount) - Math.abs(b.amount)
          break
        case 'description':
          cmp = (a.description ?? '').localeCompare(b.description ?? '')
          break
        case 'category':
          cmp = (a.category_path ?? '').localeCompare(b.category_path ?? '')
          break
        case 'account':
          cmp = a.account_name.localeCompare(b.account_name)
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

    return sorted
  }, [allTransactions, debouncedSearch, filterFn, sortKey, sortDir])

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return null
    return <span className="sort-indicator">{sortDir === 'asc' ? ' \u25B2' : ' \u25BC'}</span>
  }

  return (
    <section className="chart-section">
      <div className="section-header">
        <h2>Transactions</h2>
        <div className="controls">
          {filterLabel && onClearFilter && (
            <button className="filter-pill" onClick={onClearFilter}>
              {filterLabel}
              <span className="filter-pill-x">&times;</span>
            </button>
          )}
          <button
            className={`toggle-btn ${hideTransfers ? 'active' : ''}`}
            onClick={() => setHideTransfers(!hideTransfers)}
          >
            Hide Transfers
          </button>
          {accounts && accounts.length > 0 && onAccountChange && (
            <select
              className="account-filter"
              value={accountId ?? ''}
              onChange={(e) => onAccountChange(e.target.value || undefined)}
            >
              <option value="">All Accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.institution ? `${a.institution} — ` : ''}{a.name}
                </option>
              ))}
            </select>
          )}
          <input
            type="text"
            placeholder="Search transactions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="search-input"
          />
        </div>
      </div>
      <div className="table-container">
        <table className="txn-table">
          <thead>
            <tr>
              <th className="sortable" onClick={() => handleSort('date')}>
                Date{sortIndicator('date')}
              </th>
              <th className="sortable" onClick={() => handleSort('description')}>
                Description{sortIndicator('description')}
              </th>
              <th className="sortable" onClick={() => handleSort('category')}>
                Category{sortIndicator('category')}
              </th>
              <th className="sortable" onClick={() => handleSort('account')}>
                Account{sortIndicator('account')}
              </th>
              <th className="sortable right" onClick={() => handleSort('amount')}>
                Amount{sortIndicator('amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.id}>
                <td className="date">{t.date}</td>
                <td className="desc">{t.description}</td>
                <td className="acct">{t.category_path ?? t.description ?? '—'}</td>
                <td className="acct">
                  {t.institution ? `${t.institution} / ` : ''}{t.account_name}
                </td>
                <td className={`amount right ${t.amount >= 0 ? 'positive' : 'negative'}`}>
                  {fmtDollar(t.amount)}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', opacity: 0.5, padding: '2rem' }}>
                  No transactions found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
