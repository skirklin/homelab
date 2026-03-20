import { useCallback, useEffect, useState } from 'react'
import type { RecurringPattern, Transaction } from '../api'
import { fetchRecurring, confirmRecurring, dismissRecurring, fetchTransactions } from '../api'

const fmtDollar = (v: number) =>
  `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

export function RecurringPatterns() {
  const [patterns, setPatterns] = useState<RecurringPattern[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [expandedTxns, setExpandedTxns] = useState<Transaction[]>([])

  const refresh = useCallback(() => {
    fetchRecurring().then(setPatterns)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleConfirm = useCallback(async (id: number) => {
    await confirmRecurring(id)
    refresh()
  }, [refresh])

  const handleDismiss = useCallback(async (id: number) => {
    await dismissRecurring(id)
    refresh()
  }, [refresh])

  const toggleExpand = useCallback((p: RecurringPattern) => {
    if (expandedId === p.id) {
      setExpandedId(null)
      setExpandedTxns([])
    } else {
      setExpandedId(p.id)
      fetchTransactions({ search: p.description, limit: 50 }).then(setExpandedTxns)
    }
  }, [expandedId])

  if (patterns.length === 0) return null

  const confirmed = patterns.filter((p) => p.status === 'confirmed')
  const needsReview = patterns.filter((p) => p.status === 'detected')

  const all = [...confirmed, ...needsReview]
  const totalMonthly = confirmed.reduce((s, p) => s + p.annual_cost / 12, 0)
  const totalAnnual = confirmed.reduce((s, p) => s + p.annual_cost, 0)

  const now = new Date()
  const stale = confirmed.filter((p) => {
    const last = new Date(p.last_seen)
    const daysSince = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24)
    return p.frequency === 'monthly' && daysSince > 45
  })

  return (
    <>
      <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.85em', marginBottom: 8 }}>
        {confirmed.length} commitments &middot; {fmtDollar(totalMonthly)}/mo &middot; {fmtDollar(totalAnnual)}/yr
      </div>

      {stale.length > 0 && (
        <div className="recurring-review">
          <div className="recurring-review-label">possibly stopped:</div>
          {stale.map((p) => (
            <div key={p.id} className="recurring-review-item">
              <span className="recurring-desc">{p.description}</span>
              <span className="recurring-meta">
                {fmtDollar(p.avg_amount)}/{p.frequency} &middot; last seen {p.last_seen}
              </span>
              <button className="suggestion-reject" onClick={() => handleDismiss(p.id)}>remove</button>
            </div>
          ))}
        </div>
      )}

      <table className="cat-stats-table">
        <thead>
          <tr>
            <th>description</th>
            <th>category</th>
            <th className="right">amount</th>
            <th>freq</th>
            <th className="right">annual</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {all.map((p) => (
            <tr key={p.id} className="cat-stats-row" onClick={() => toggleExpand(p)}>
              <td className="cat-name">{p.description}</td>
              <td className="dim">{p.category_path || '?'}</td>
              <td className="right num">{fmtDollar(p.avg_amount)}</td>
              <td className="dim">{p.frequency}</td>
              <td className="right num">{fmtDollar(p.annual_cost)}</td>
              <td className="cat-actions">
                {p.status === 'detected' && (
                  <>
                    <button className="suggestion-accept" onClick={(e) => { e.stopPropagation(); handleConfirm(p.id) }}>confirm</button>
                    <button className="suggestion-reject" onClick={(e) => { e.stopPropagation(); handleDismiss(p.id) }}>dismiss</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {expandedId && expandedTxns.length > 0 && (
        <div className="recurring-txns">
          {expandedTxns.map((t) => (
            <div key={t.id} className="recurring-txn-row">
              <span className="dim">{t.date}</span>
              <span>{t.description}</span>
              <span className="num">{fmtDollar(t.amount)}</span>
              <span className="dim">{t.account_name}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
