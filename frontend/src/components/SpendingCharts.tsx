import { useCallback, useEffect, useMemo, useState } from 'react'
import Plot from 'react-plotly.js'
import type { Transaction, TimeRange } from '../api'
import { fetchTransactions, reclassifyTransaction } from '../api'

const fmtDollar = (v: number) =>
  `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

const PALETTE = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399',
  '#22d3ee', '#818cf8', '#c084fc', '#f472b6', '#94a3b8',
  '#e879f9', '#67e8f9',
]

const TIME_PRESETS = [
  { label: '3m', key: '3m' },
  { label: '6m', key: '6m' },
  { label: '1y', key: '1y' },
  { label: 'all', key: 'all' },
]

function buildColorMap(categories: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  categories.forEach((cat, i) => {
    map[cat] = PALETTE[i % PALETTE.length]
  })
  return map
}

/** Extract the next path segment below a prefix, or the top-level segment if no prefix */
function nextSegment(path: string, prefix: string | null): string {
  if (!prefix) {
    const slash = path.indexOf('/')
    return slash === -1 ? path : path.slice(0, slash)
  }
  const rest = path.slice(prefix.length + 1)
  const slash = rest.indexOf('/')
  return slash === -1 ? rest : rest.slice(0, slash)
}

/** Check if a path is under a prefix */
function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/')
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

interface SpendingChartsProps {
  prefix: string | null
  onPrefixChange: (prefix: string | null) => void
  onBarClick?: (month: string, category: string) => void
  timeRange?: TimeRange
  timeKey: string
  onTimeKeyChange: (key: string) => void
  onRecurringClick?: () => void
  recurringActive?: boolean
  transactionFilter?: (t: Transaction) => boolean
}

export function SpendingCharts({
  prefix,
  onPrefixChange,
  onBarClick,
  timeRange,
  timeKey,
  onTimeKeyChange,
  onRecurringClick,
  recurringActive,
  transactionFilter,
}: SpendingChartsProps) {
  const [allTxns, setAllTxns] = useState<Transaction[]>([])
  const [reclassifyingId, setReclassifyingId] = useState<number | null>(null)
  const [reclassifyFeedback, setReclassifyFeedback] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  // Clear exclusions when drilling in/out
  useEffect(() => { setExcluded(new Set()) }, [prefix])

  const toggleExclude = useCallback((catPrefix: string) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(catPrefix)) next.delete(catPrefix)
      else next.add(catPrefix)
      return next
    })
  }, [])

  // Fetch all transactions once
  useEffect(() => {
    fetchTransactions({ limit: 10000, hideTransfers: true }).then(setAllTxns)
  }, [])

  // Apply all filters: time range, exclude capital, prefix, custom filter
  const filtered = useMemo(() => {
    let txns = allTxns.filter((t) => {
      if (t.amount >= 0) return false
      const path = t.category_path ?? ''
      if (path.startsWith('capital')) return false
      if (timeRange?.start && t.date < timeRange.start) return false
      if (timeRange?.end && t.date > timeRange.end) return false
      if (prefix && !matchesPrefix(path, prefix)) return false
      return true
    })
    if (transactionFilter) txns = txns.filter(transactionFilter)
    return txns
  }, [allTxns, timeRange, prefix, transactionFilter])

  // Compute child categories (next segment below prefix)
  const childCats = useMemo(() => {
    const counts = new Map<string, { total: number; count: number; txns: Transaction[] }>()
    for (const t of filtered) {
      const path = t.category_path ?? 'uncategorized'
      // If path === prefix exactly (no further nesting), child is the path itself
      const child = (!prefix && !path.includes('/'))
        ? path
        : (prefix && path === prefix)
          ? path
          : nextSegment(path, prefix)
      if (!child) continue
      const existing = counts.get(child) ?? { total: 0, count: 0, txns: [] }
      existing.total += t.amount
      existing.count += 1
      existing.txns.push(t)
      counts.set(child, existing)
    }
    return counts
  }, [filtered, prefix])

  // Is this a leaf? (only one child that equals the prefix, or zero children)
  const isLeaf = useMemo(() => {
    if (!prefix) return false
    if (childCats.size === 0) return true
    if (childCats.size === 1 && childCats.has(prefix)) return true
    return false
  }, [childCats, prefix])

  // Stats for each child category
  const stats = useMemo(() => {
    const totalSpend = [...childCats.values()].reduce((s, c) => s + Math.abs(c.total), 0)
    const entries: { category: string; data: typeof childCats extends Map<string, infer V> ? V : never }[] = []
    childCats.forEach((data, cat) => entries.push({ category: cat, data }))
    entries.sort((a, b) => a.data.total - b.data.total)

    // Compute monthly breakdown per category for stats
    return entries.slice(0, 15).map(({ category, data }) => {
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

      return {
        category,
        total: data.total,
        count: data.count,
        avg,
        min,
        max,
        stddev: Math.sqrt(variance),
        pctOfTotal: totalSpend > 0 ? (Math.abs(data.total) / totalSpend) * 100 : 0,
      } satisfies CatStats
    })
  }, [childCats])

  // Monthly stacked bar data (excludes hidden categories)
  const chartData = useMemo(() => {
    const monthCats = new Map<string, Map<string, number>>()
    const allCats = new Set<string>()

    for (const t of filtered) {
      const path = t.category_path ?? 'uncategorized'
      // Skip excluded categories in the chart
      let isExcluded = false
      for (const ex of excluded) {
        if (matchesPrefix(path, ex)) { isExcluded = true; break }
      }
      if (isExcluded) continue

      const child = (!prefix && !path.includes('/'))
        ? path
        : (prefix && path === prefix)
          ? path
          : nextSegment(path, prefix)
      if (!child) continue
      allCats.add(child)
      const month = t.date.slice(0, 7)
      if (!monthCats.has(month)) monthCats.set(month, new Map())
      const catMap = monthCats.get(month)!
      catMap.set(child, (catMap.get(child) ?? 0) + Math.abs(t.amount))
    }

    const months = [...monthCats.keys()].sort()
    const categories = [...allCats]
    return { months, categories, monthCats }
  }, [filtered, prefix, excluded])

  // Totals row
  const totals = useMemo(() => {
    const totalSpend = filtered.reduce((s, t) => s + Math.abs(t.amount), 0)
    const totalCount = filtered.length
    const monthly = new Map<string, number>()
    for (const t of filtered) {
      const month = t.date.slice(0, 7)
      monthly.set(month, (monthly.get(month) ?? 0) + Math.abs(t.amount))
    }
    const values = [...monthly.values()]
    const n = values.length
    const avg = n > 0 ? values.reduce((s, v) => s + v, 0) / n : 0
    const min = n > 0 ? Math.min(...values) : 0
    const max = n > 0 ? Math.max(...values) : 0
    const variance = n > 0 ? values.reduce((s, v) => s + (v - avg) ** 2, 0) / n : 0
    return { totalSpend, totalCount, avg, min, max, stddev: Math.sqrt(variance) }
  }, [filtered])

  const colorMap = useMemo(
    () => buildColorMap(stats.map((s) => s.category)),
    [stats],
  )

  if (allTxns.length === 0) return null

  const segments = prefix ? prefix.split('/') : []

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
            <span
              className={prefix ? 'breadcrumb-link' : ''}
              onClick={prefix ? () => onPrefixChange(null) : undefined}
            >
              spending
            </span>
            {segments.map((seg, i) => {
              const path = segments.slice(0, i + 1).join('/')
              const isLast = i === segments.length - 1
              return (
                <span key={path}>
                  <span className="breadcrumb-sep"> / </span>
                  <span
                    className={isLast ? '' : 'breadcrumb-link'}
                    onClick={isLast ? undefined : () => onPrefixChange(path)}
                  >
                    {seg}
                  </span>
                </span>
              )
            })}
          </h2>
          <div className="controls">
            {onRecurringClick && (
              <button
                className={`toggle-btn ${recurringActive ? 'active' : ''}`}
                onClick={onRecurringClick}
              >recurring</button>
            )}
            <div className="time-presets">
              {TIME_PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={`time-preset-btn ${timeKey === p.key ? 'active' : ''}`}
                  onClick={() => onTimeKeyChange(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <Plot
            data={traces}
            layout={{
              barmode: 'stack',
              paper_bgcolor: 'transparent',
              plot_bgcolor: 'transparent',
              font: { color: 'rgba(255,255,255,0.6)', size: 11 },
              margin: { l: 60, r: 10, t: 10, b: 30 },
              xaxis: {
                gridcolor: 'rgba(255,255,255,0.06)',
                linecolor: 'rgba(255,255,255,0.06)',
              },
              yaxis: {
                gridcolor: 'rgba(255,255,255,0.06)',
                linecolor: 'rgba(255,255,255,0.06)',
                tickprefix: '$',
                separatethousands: true,
              },
              showlegend: false,
              hoverlabel: {
                bgcolor: '#1e1e3f',
                bordercolor: 'rgba(255,255,255,0.1)',
                font: { color: 'rgba(255,255,255,0.8)', size: 12 },
              },
            }}
            config={{ responsive: true, displayModeBar: false }}
            useResizeHandler
            style={{ width: '100%', height: 350 }}
            onClick={(event) => {
              if (!onBarClick || !event.points || event.points.length === 0) return
              const pt = event.points[0]
              onBarClick(pt.x as string, pt.data.name as string)
            }}
          />
      </section>

      {!isLeaf && (
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
              <tr
                className={`cat-stats-totals ${prefix ? 'cat-stats-row' : ''}`}
                onClick={prefix ? () => {
                  const parts = prefix.split('/')
                  onPrefixChange(parts.length > 1 ? parts.slice(0, -1).join('/') : null)
                } : undefined}
              >
                <td>{prefix && <span className="back-arrow">&larr;</span>}</td>
                <td className="cat-name">{prefix ? segments[segments.length - 1] : 'total'}</td>
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
                const childPrefix = prefix ? `${prefix}/${s.category}` : s.category
                const isExcluded = excluded.has(childPrefix)
                return (
                  <tr
                    key={s.category}
                    className={`cat-stats-row ${isExcluded ? 'excluded' : ''}`}
                    onClick={(e) => {
                      if (e.ctrlKey || e.metaKey) toggleExclude(childPrefix)
                      else onPrefixChange(childPrefix)
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

      {isLeaf && filtered.length > 0 && (
          <div className="table-container">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>date</th>
                  <th>description</th>
                  <th>account</th>
                  <th className="right">amount</th>
                  <th></th>
                </tr>
                <tr
                  className="cat-stats-totals cat-stats-row"
                  onClick={() => {
                    const parts = prefix!.split('/')
                    onPrefixChange(parts.length > 1 ? parts.slice(0, -1).join('/') : null)
                  }}
                >
                  <td><span className="back-arrow">&larr;</span></td>
                  <td className="cat-name">{segments[segments.length - 1]}</td>
                  <td></td>
                  <td className="right num">{fmtDollar(totals.totalSpend)}</td>
                  <td></td>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
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
              </tbody>
            </table>
          </div>
      )}
    </>
  )
}
