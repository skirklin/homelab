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

  // Group by top-level category
  const grouped = new Map<string, RecurringPattern[]>()
  for (const p of all) {
    const topLevel = (p.category_path || 'uncategorized').split('/')[0]
    if (!grouped.has(topLevel)) grouped.set(topLevel, [])
    grouped.get(topLevel)!.push(p)
  }
  // Sort groups by total annual cost
  const sortedGroups = [...grouped.entries()].sort((a, b) => {
    const aTotal = a[1].reduce((s, p) => s + p.annual_cost, 0)
    const bTotal = b[1].reduce((s, p) => s + p.annual_cost, 0)
    return bTotal - aTotal
  })

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

      {sortedGroups.map(([group, items]) => {
        const groupAnnual = items.reduce((s, p) => s + p.annual_cost, 0)
        return (
          <div key={group} className="recurring-group">
            <div className="recurring-group-header">
              <span>{group}</span>
              <span className="dim">{fmtDollar(groupAnnual)}/yr</span>
            </div>
            <table className="cat-stats-table">
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className="cat-stats-row" onClick={() => toggleExpand(p)}>
                    <td className="cat-name">{p.description}</td>
                    <td className="dim">{p.category_path?.split('/').slice(1).join('/') || ''}</td>
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
            {items.some((p) => p.id === expandedId) && expandedTxns.length > 0 && (
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
          </div>
        )
      })}
    </>
  )
}
