import { useEffect, useState } from 'react'
import type { Transaction } from '../api'
import { fetchTransactions } from '../api'

const fmtDollar = (v: number) =>
  `${v < 0 ? '-' : '+'}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function TransactionTable() {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    fetchTransactions({
      search: debouncedSearch || undefined,
      limit: 100,
    }).then(setTransactions)
  }, [debouncedSearch])

  return (
    <section className="chart-section">
      <div className="section-header">
        <h2>Recent Transactions</h2>
        <input
          type="text"
          placeholder="Search transactions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
        />
      </div>
      <div className="table-container">
        <table className="txn-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Account</th>
              <th className="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.id}>
                <td className="date">{t.date}</td>
                <td className="desc">{t.description}</td>
                <td className="acct">{t.account_name}</td>
                <td className={`amount right ${t.amount >= 0 ? 'positive' : 'negative'}`}>
                  {fmtDollar(t.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
