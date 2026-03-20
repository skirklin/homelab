import { useCallback, useEffect, useState } from 'react'
import type { RecurringPattern } from '../api'
import { fetchRecurring, confirmRecurring, dismissRecurring } from '../api'

const fmtDollar = (v: number) =>
  `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

export function RecurringPatterns() {
  const [patterns, setPatterns] = useState<RecurringPattern[]>([])

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

  if (patterns.length === 0) return null

  const totalMonthly = patterns.reduce((s, p) => {
    if (p.frequency === 'monthly') return s + p.avg_amount
    if (p.frequency === 'annual') return s + p.avg_amount / 12
    if (p.frequency === 'quarterly') return s + p.avg_amount / 3
    if (p.frequency === 'weekly') return s + p.avg_amount * 4.33
    return s + p.avg_amount
  }, 0)
  const totalAnnual = patterns.reduce((s, p) => s + p.annual_cost, 0)

  return (
    <section className="chart-section">
      <div className="section-header">
        <h2>
          recurring
          <span style={{ fontWeight: 300, fontSize: '0.6em', color: 'rgba(255,255,255,0.4)', marginLeft: 12 }}>
            {fmtDollar(totalMonthly)}/mo &middot; {fmtDollar(totalAnnual)}/yr
          </span>
        </h2>
      </div>
      <table className="cat-stats-table">
        <thead>
          <tr>
            <th>description</th>
            <th>category</th>
            <th className="right">amount</th>
            <th>frequency</th>
            <th className="right">annual</th>
            <th className="right">seen</th>
            <th>last</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {patterns.map((p) => (
            <tr key={p.id} className="cat-stats-row">
              <td className="cat-name">{p.description}</td>
              <td className="dim">{p.category_path || '?'}</td>
              <td className="right num">{fmtDollar(p.avg_amount)}</td>
              <td className="dim">{p.frequency}</td>
              <td className="right num">{fmtDollar(p.annual_cost)}</td>
              <td className="right num dim">{p.match_count}x</td>
              <td className="dim">{p.last_seen}</td>
              <td className="cat-actions">
                {p.status === 'detected' && (
                  <>
                    <button
                      className="suggestion-accept"
                      onClick={() => handleConfirm(p.id)}
                    >
                      confirm
                    </button>
                    <button
                      className="suggestion-reject"
                      onClick={() => handleDismiss(p.id)}
                    >
                      dismiss
                    </button>
                  </>
                )}
                {p.status === 'confirmed' && (
                  <span className="dim" style={{ fontSize: 11 }}>confirmed</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
