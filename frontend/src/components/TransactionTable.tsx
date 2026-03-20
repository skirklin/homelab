import { useEffect, useMemo, useState } from 'react'
import type { Account, Transaction } from '../api'
import { fetchTransactions } from '../api'

const fmtDollar = (v: number) =>
  `${v < 0 ? '-' : '+'}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

interface Props {
  accounts?: Account[]
  accountId?: string
  onAccountChange?: (id: string | undefined) => void
  /** Client-side filter function applied on top of the fetched data */
  filterFn?: (t: Transaction) => boolean
  /** Label describing the active filter */
  filterLabel?: string
  /** Called when user clears the filter */
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

  const filtered = useMemo(() => {
    let result = allTransactions

    // Client-side text search
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

    // External filter (from chart clicks)
    if (filterFn) {
      result = result.filter(filterFn)
    }

    return result
  }, [allTransactions, debouncedSearch, filterFn])

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
              <th>Date</th>
              <th>Description</th>
              <th>Category</th>
              <th>Account</th>
              <th className="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
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
            {filtered.length === 0 && (
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
