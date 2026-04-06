import { useCallback, useEffect, useState } from 'react'
import type { RecurringPattern, Transaction } from '../api'
import { fetchRecurring, confirmRecurring, dismissRecurring, fetchTransactions } from '../api'

const fmtDollar = (v: number) =>
  `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

export function RecurringPatterns() {
  const [patterns, setPatterns] = useState<RecurringPattern[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [expandedTxns, setExpandedTxns] = useState<Transaction[]>([])
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

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

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }, [])

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
      <div className="tree-summary">
        {confirmed.length} commitments &middot; {fmtDollar(totalMonthly)}/mo &middot; {fmtDollar(totalAnnual)}/yr
      </div>

      {stale.length > 0 && (
        <div className="recurring-review">
          <div className="recurring-review-label">possibly stopped:</div>
          {stale.map((p) => (
            <div key={p.id} className="recurring-review-item">
              <span className="recurring-desc">{p.display_name}</span>
              <span className="recurring-meta">
                {fmtDollar(p.avg_amount)}/{p.frequency} &middot; last seen {p.last_seen}
              </span>
              <button className="suggestion-reject" onClick={() => handleDismiss(p.id)}>remove</button>
            </div>
          ))}
        </div>
      )}

      <div className="tree">
        {sortedGroups.map(([group, items]) => {
          const groupAnnual = items.reduce((s, p) => s + p.annual_cost, 0)
          const isCollapsed = collapsedGroups.has(group)
          return (
            <div key={group} className="tree-group">
              <div className="tree-group-row" onClick={() => toggleGroup(group)}>
                <span className="tree-toggle">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
                <span className="tree-group-name">{group}</span>
                <span className="tree-group-stats">
                  {fmtDollar(groupAnnual / 12)}/mo &middot; {fmtDollar(groupAnnual)}/yr
                </span>
              </div>
              {!isCollapsed && items.map((p) => (
                <div key={p.id} className="tree-item-container">
                  <div className="tree-item" onClick={() => toggleExpand(p)}>
                    <span className="tree-indent" />
                    <span className="tree-item-name">{p.display_name}</span>
                    <span className="tree-item-stats">
                      {fmtDollar(p.avg_amount)}/{p.frequency}
                      <span className="dim"> &middot; {fmtDollar(p.annual_cost)}/yr</span>
                    </span>
                    {p.status === 'detected' && (
                      <span className="tree-item-actions">
                        <button className="suggestion-accept" onClick={(e) => { e.stopPropagation(); handleConfirm(p.id) }}>confirm</button>
                        <button className="suggestion-reject" onClick={(e) => { e.stopPropagation(); handleDismiss(p.id) }}>dismiss</button>
                      </span>
                    )}
                  </div>
                  {expandedId === p.id && expandedTxns.length > 0 && (
                    <div className="tree-txns">
                      {expandedTxns.map((t) => (
                        <div key={t.id} className="tree-txn-row">
                          <span className="dim">{t.date}</span>
                          <span>{t.description}</span>
                          <span className="num">{fmtDollar(t.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}
