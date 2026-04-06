/**
 * Generic chart + stats table + leaf transaction view.
 *
 * Takes a flat array of transactions and a grouping function.
 * Groups transactions, computes stats, renders stacked bar chart
 * and stats table. When drilled to a leaf, shows individual transactions.
 *
 * Decoupled from data fetching — the parent page owns the data.
 */
import { useCallback, useMemo, useState } from 'react'
import Plot from 'react-plotly.js'
import type { Transaction } from '../api'
import { reclassifyTransaction } from '../api'

const fmtDollar = (v: number) =>
  `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

const PALETTE = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399',
  '#22d3ee', '#818cf8', '#c084fc', '#f472b6', '#94a3b8',
  '#e879f9', '#67e8f9',
]

function buildColorMap(categories: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  categories.forEach((cat, i) => {
    map[cat] = PALETTE[i % PALETTE.length]
  })
  return map
}

interface CatStats {
  category: string
  total: number
  count: number
  avg: number
  min: number
  max: number
  stddev: number
  pctOfTotal: number
}

export interface CategoryChartProps {
  /** All transactions to display (already filtered by the parent) */
  transactions: Transaction[]
  /** Extract the group name for a transaction. Return null to exclude. */
  groupFn: (t: Transaction) => string | null
  /** Called when a category row is clicked */
  onCategoryClick?: (category: string) => void
  /** Current drill-down path segments */
  breadcrumbs?: { label: string; onClick: () => void }[]
  /** Header controls (time presets, toggles, etc.) rendered in the header */
  headerControls?: React.ReactNode
}

export function CategoryChart({
  transactions,
  groupFn,
  onCategoryClick,
  breadcrumbs,
  headerControls,
}: CategoryChartProps) {
  const [reclassifyingId, setReclassifyingId] = useState<number | null>(null)
  const [reclassifyFeedback, setReclassifyFeedback] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  const toggleExclude = useCallback((cat: string) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }, [])

  // Group transactions
  const groups = useMemo(() => {
    const map = new Map<string, { total: number; count: number; txns: Transaction[] }>()
    for (const t of transactions) {
      const group = groupFn(t)
      if (!group) continue
      const existing = map.get(group) ?? { total: 0, count: 0, txns: [] }
      existing.total += t.amount
      existing.count += 1
      existing.txns.push(t)
      map.set(group, existing)
    }
    return map
  }, [transactions, groupFn])

  const isLeaf = groups.size <= 1 && transactions.length > 0

  // Stats sorted by total
  const stats = useMemo(() => {
    const totalSpend = [...groups.values()].reduce((s, g) => s + Math.abs(g.total), 0)
    const entries: CatStats[] = []
    groups.forEach((data, category) => {
      const monthly = new Map<string, number>()
      for (const t of data.txns) {
        const month = t.date.slice(0, 7)
        monthly.set(month, (monthly.get(month) ?? 0) + Math.abs(t.amount))
      }
      const values = [...monthly.values()]
      const n = values.length
      const avg = n > 0 ? values.reduce((s, v) => s + v, 0) / n : 0
      const min = n > 0 ? Math.min(...values) : 0
      const max = n > 0 ? Math.max(...values) : 0
      const variance = n > 0 ? values.reduce((s, v) => s + (v - avg) ** 2, 0) / n : 0
      entries.push({
        category,
        total: data.total,
        count: data.count,
        avg, min, max,
        stddev: Math.sqrt(variance),
        pctOfTotal: totalSpend > 0 ? (Math.abs(data.total) / totalSpend) * 100 : 0,
      })
    })
    return entries.sort((a, b) => a.total - b.total).slice(0, 15)
  }, [groups])

  // Chart data (excludes hidden categories)
  const chartData = useMemo(() => {
    const monthCats = new Map<string, Map<string, number>>()
    const allCats = new Set<string>()
    for (const t of transactions) {
      const group = groupFn(t)
      if (!group || excluded.has(group)) continue
      allCats.add(group)
      const month = t.date.slice(0, 7)
      if (!monthCats.has(month)) monthCats.set(month, new Map())
      monthCats.get(month)!.set(group, (monthCats.get(month)!.get(group) ?? 0) + Math.abs(t.amount))
    }
    return { months: [...monthCats.keys()].sort(), categories: [...allCats], monthCats }
  }, [transactions, groupFn, excluded])

  // Totals
  const totals = useMemo(() => {
    const totalSpend = transactions.reduce((s, t) => s + Math.abs(t.amount), 0)
    const monthly = new Map<string, number>()
    for (const t of transactions) {
      const month = t.date.slice(0, 7)
      monthly.set(month, (monthly.get(month) ?? 0) + Math.abs(t.amount))
    }
    const values = [...monthly.values()]
    const n = values.length
    const avg = n > 0 ? values.reduce((s, v) => s + v, 0) / n : 0
    const min = n > 0 ? Math.min(...values) : 0
    const max = n > 0 ? Math.max(...values) : 0
    const variance = n > 0 ? values.reduce((s, v) => s + (v - avg) ** 2, 0) / n : 0
    return { totalSpend, totalCount: transactions.length, avg, min, max, stddev: Math.sqrt(variance) }
  }, [transactions])

  const colorMap = useMemo(() => buildColorMap(stats.map((s) => s.category)), [stats])

  const traces: Plotly.Data[] = chartData.categories.map((cat) => ({
    x: chartData.months,
    y: chartData.months.map((m) => chartData.monthCats.get(m)?.get(cat) ?? 0),
    name: cat,
    type: 'bar' as const,
    marker: { color: colorMap[cat] || '#94a3b8' },
    hovertemplate: `%{x}<br>${cat}: $%{y:,.0f}<extra></extra>`,
  }))

  return (
    <>
      <section className="chart-section">
        <div className="section-header">
          <h2>
            {breadcrumbs?.map((b, i) => (
              <span key={i}>
                {i > 0 && <span className="breadcrumb-sep"> / </span>}
                <span
                  className={i < (breadcrumbs.length - 1) ? 'breadcrumb-link' : ''}
                  onClick={i < (breadcrumbs.length - 1) ? b.onClick : undefined}
                >
                  {b.label}
                </span>
              </span>
            ))}
          </h2>
          {headerControls && <div className="controls">{headerControls}</div>}
        </div>
        <Plot
          data={traces}
          layout={{
            barmode: 'stack',
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { color: 'rgba(255,255,255,0.6)', size: 11 },
            margin: { l: 60, r: 10, t: 10, b: 30 },
            xaxis: { gridcolor: 'rgba(255,255,255,0.06)', linecolor: 'rgba(255,255,255,0.06)' },
            yaxis: { gridcolor: 'rgba(255,255,255,0.06)', linecolor: 'rgba(255,255,255,0.06)', tickprefix: '$', separatethousands: true },
            showlegend: false,
            hoverlabel: { bgcolor: '#1e1e3f', bordercolor: 'rgba(255,255,255,0.1)', font: { color: 'rgba(255,255,255,0.8)', size: 12 } },
          }}
          config={{ responsive: true, displayModeBar: false }}
          useResizeHandler
          style={{ width: '100%', height: 350 }}
        />
      </section>

      {!isLeaf && stats.length > 0 && (
        <>
          <table className="cat-stats-table">
            <thead>
              <tr>
                <th></th>
                <th>category</th>
                <th className="right">total</th>
                <th className="right">%</th>
                <th className="right">avg/mo</th>
                <th className="right">min/mo</th>
                <th className="right">max/mo</th>
                <th className="right">stddev</th>
                <th className="right">txns</th>
              </tr>
            </thead>
            <tbody>
              <tr className="cat-stats-totals">
                <td></td>
                <td className="cat-name">total</td>
                <td className="right num">{fmtDollar(totals.totalSpend)}</td>
                <td className="right num dim">100%</td>
                <td className="right num">{fmtDollar(totals.avg)}</td>
                <td className="right num dim">{fmtDollar(totals.min)}</td>
                <td className="right num dim">{fmtDollar(totals.max)}</td>
                <td className="right num dim">{fmtDollar(totals.stddev)}</td>
                <td className="right num dim">{totals.totalCount}</td>
              </tr>
              {stats.map((s) => {
                const color = colorMap[s.category] || '#94a3b8'
                const isExcluded = excluded.has(s.category)
                return (
                  <tr
                    key={s.category}
                    className={`cat-stats-row ${isExcluded ? 'excluded' : ''}`}
                    onClick={(e) => {
                      if (e.ctrlKey || e.metaKey) toggleExclude(s.category)
                      else onCategoryClick?.(s.category)
                    }}
                  >
                    <td>
                      <span className="cat-dot" style={{ backgroundColor: isExcluded ? 'transparent' : color, border: isExcluded ? `2px solid ${color}` : 'none' }} />
                    </td>
                    <td className="cat-name">{s.category}</td>
                    <td className="right num">{fmtDollar(s.total)}</td>
                    <td className="right num dim">{s.pctOfTotal.toFixed(1)}%</td>
                    <td className="right num">{fmtDollar(s.avg)}</td>
                    <td className="right num dim">{fmtDollar(s.min)}</td>
                    <td className="right num dim">{fmtDollar(s.max)}</td>
                    <td className="right num dim">{fmtDollar(s.stddev)}</td>
                    <td className="right num dim">{s.count}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      {isLeaf && transactions.length > 0 && (
        <div className="table-container" style={{ maxHeight: 'none' }}>
          <table className="txn-table">
            <thead>
              <tr>
                <th>date</th>
                <th>description</th>
                <th>account</th>
                <th className="right">amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => {
                const isReclassifying = reclassifyingId === t.id
                return (
                  <tr key={t.id}>
                    <td className="date">{t.date}</td>
                    <td className="desc">{t.description}</td>
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
                          onClick={() => { setReclassifyingId(t.id); setReclassifyFeedback('') }}
                        >?</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
