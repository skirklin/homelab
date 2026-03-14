import { useEffect, useState } from 'react'
import type { Account, Transaction } from '../api'
import { fetchTransactions } from '../api'

const fmtDollar = (v: number) =>
  `${v < 0 ? '-' : '+'}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

interface Props {
  accounts?: Account[]
  accountId?: string
  onAccountChange?: (id: string | undefined) => void
}

export function TransactionTable({ accounts, accountId, onAccountChange }: Props) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [hideTransfers, setHideTransfers] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    fetchTransactions({
      search: debouncedSearch || undefined,
      accountId: accountId,
      hideTransfers,
      limit: 200,
    }).then(setTransactions)
  }, [debouncedSearch, accountId, hideTransfers])

  return (
    <section className="chart-section">
      <div className="section-header">
        <h2>Transactions</h2>
        <div className="controls">
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
            {transactions.map((t) => (
              <tr key={t.id}>
                <td className="date">{t.date}</td>
                <td className="desc">{t.description}</td>
                <td className="acct">{t.category ?? '—'}</td>
                <td className="acct">
                  {t.institution ? `${t.institution} / ` : ''}{t.account_name}
                </td>
                <td className={`amount right ${t.amount >= 0 ? 'positive' : 'negative'}`}>
                  {fmtDollar(t.amount)}
                </td>
              </tr>
            ))}
            {transactions.length === 0 && (
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
