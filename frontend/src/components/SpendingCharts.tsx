import { useCallback, useEffect, useMemo, useState } from 'react'
import Plot from 'react-plotly.js'
import type { MonthCategoryData, CategorySummary, TimeRange, Transaction } from '../api'
import {
  fetchSpendingByMonthCategory,
  fetchSpendingByCategory,
  fetchTransactions,
  reclassifyTransaction,
} from '../api'

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

function computeStats(
  categories: CategorySummary[],
  monthData: MonthCategoryData | null,
  totalSpend: number,
): CatStats[] {
  if (!monthData) {
    return categories.map((c) => ({
      category: c.category,
      total: c.total,
      count: c.count,
      avg: 0, min: 0, max: 0, stddev: 0,
      pctOfTotal: totalSpend > 0 ? (Math.abs(c.total) / totalSpend) * 100 : 0,
    }))
  }

  return categories.map((c) => {
    const monthly = monthData.months.map((m) => (m[c.category] as number) || 0)
    const n = monthly.length
    const avg = n > 0 ? monthly.reduce((s, v) => s + v, 0) / n : 0
    const min = n > 0 ? Math.min(...monthly) : 0
    const max = n > 0 ? Math.max(...monthly) : 0
    const variance = n > 0
      ? monthly.reduce((s, v) => s + (v - avg) ** 2, 0) / n
      : 0

    return {
      category: c.category,
      total: c.total,
      count: c.count,
      avg,
      min,
      max,
      stddev: Math.sqrt(variance),
      pctOfTotal: totalSpend > 0 ? (Math.abs(c.total) / totalSpend) * 100 : 0,
    }
  })
}

interface SpendingChartsProps {
  prefix: string | null
  onPrefixChange: (prefix: string | null) => void
  onBarClick?: (month: string, category: string) => void
  timeRange?: TimeRange
  timeKey: string
  onTimeKeyChange: (key: string) => void
}

export function SpendingCharts({
  prefix,
  onPrefixChange,
  onBarClick,
  timeRange,
  timeKey,
  onTimeKeyChange,
}: SpendingChartsProps) {
  const [monthCatData, setMonthCatData] = useState<MonthCategoryData | null>(null)
  const [categories, setCategories] = useState<CategorySummary[]>([])
  const [expandedCat, setExpandedCat] = useState<string | null>(null)
  const [expandedTxns, setExpandedTxns] = useState<Transaction[]>([])
  const [reclassifyingId, setReclassifyingId] = useState<number | null>(null)
  const [reclassifyFeedback, setReclassifyFeedback] = useState('')

  const toggleExpand = useCallback((catPrefix: string) => {
    if (expandedCat === catPrefix) {
      setExpandedCat(null)
      setExpandedTxns([])
    } else {
      setExpandedCat(catPrefix)
      // Fetch transactions matching this category prefix
      fetchTransactions({ limit: 200 }).then((txns) => {
        setExpandedTxns(
          txns.filter((t) => {
            const path = t.category_path ?? ''
            return path === catPrefix || path.startsWith(catPrefix + '/')
          })
        )
      })
    }
  }, [expandedCat])

  useEffect(() => {
    fetchSpendingByMonthCategory(15, prefix ?? undefined, timeRange).then(setMonthCatData)
    fetchSpendingByCategory(prefix ?? undefined, timeRange).then(setCategories)
  }, [prefix, timeRange])

  const colorMap = useMemo(() => {
    const allCats = new Set<string>()
    if (monthCatData) monthCatData.categories.forEach((c) => allCats.add(c))
    categories.forEach((c) => allCats.add(c.category))
    const sorted = [...allCats].sort((a, b) => {
      const aTotal = categories.find((c) => c.category === a)?.total ?? 0
      const bTotal = categories.find((c) => c.category === b)?.total ?? 0
      return aTotal - bTotal
    })
    return buildColorMap(sorted)
  }, [monthCatData, categories])

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.total - b.total).slice(0, 15),
    [categories],
  )

  const totalSpend = useMemo(
    () => categories.reduce((s, c) => s + Math.abs(c.total), 0),
    [categories],
  )

  const totalCount = useMemo(
    () => categories.reduce((s, c) => s + c.count, 0),
    [categories],
  )

  const stats = useMemo(
    () => computeStats(sortedCategories, monthCatData, totalSpend),
    [sortedCategories, monthCatData, totalSpend],
  )

  // Totals row stats
  const totalsRow = useMemo(() => {
    if (!monthCatData) return null
    const monthlyTotals = monthCatData.months.map((m) => {
      let sum = 0
      for (const cat of monthCatData.categories) {
        sum += (m[cat] as number) || 0
      }
      return sum
    })
    const n = monthlyTotals.length
    const avg = n > 0 ? monthlyTotals.reduce((s, v) => s + v, 0) / n : 0
    const min = n > 0 ? Math.min(...monthlyTotals) : 0
    const max = n > 0 ? Math.max(...monthlyTotals) : 0
    const variance = n > 0
      ? monthlyTotals.reduce((s, v) => s + (v - avg) ** 2, 0) / n
      : 0
    return { avg, min, max, stddev: Math.sqrt(variance) }
  }, [monthCatData])

  if (!monthCatData || monthCatData.months.length === 0) return null

  const months = monthCatData.months.map((m) => m.month as string)

  const traces: Plotly.Data[] = monthCatData.categories.map((cat) => ({
    x: months,
    y: monthCatData.months.map((m) => (m[cat] as number) || 0),
    name: cat,
    type: 'bar' as const,
    marker: { color: colorMap[cat] || '#94a3b8' },
    hovertemplate: `%{x}<br>${cat}: $%{y:,.0f}<extra></extra>`,
  }))

  const segments = prefix ? prefix.split('/') : []

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

      <section className="chart-section">
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
            {totalsRow && (
              <tr className="cat-stats-totals">
                <td></td>
                <td className="cat-name">total</td>
                <td className="right num">{fmtDollar(totalSpend)}</td>
                <td className="right num dim">100%</td>
                <td className="right num">{fmtDollar(totalsRow.avg)}</td>
                <td className="right num dim">{fmtDollar(totalsRow.min)}</td>
                <td className="right num dim">{fmtDollar(totalsRow.max)}</td>
                <td className="right num dim">{fmtDollar(totalsRow.stddev)}</td>
                <td className="right num dim">{totalCount}</td>
              </tr>
            )}
            {stats.map((s) => {
              const color = colorMap[s.category] || '#94a3b8'
              const childPrefix = prefix ? `${prefix}/${s.category}` : s.category
              const isExpanded = expandedCat === childPrefix
              return (
                <tr
                  key={s.category}
                  className={`cat-stats-row ${isExpanded ? 'expanded' : ''}`}
                  onClick={() => toggleExpand(childPrefix)}
                  onDoubleClick={() => onPrefixChange(childPrefix)}
                >
                  <td>
                    <span className="cat-dot" style={{ backgroundColor: color }} />
                  </td>
                  <td className="cat-name">
                    {s.category}
                    <span
                      className="drill-link"
                      onClick={(e) => { e.stopPropagation(); onPrefixChange(childPrefix) }}
                    >
                      &rarr;
                    </span>
                  </td>
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
            {expandedCat && expandedTxns.length > 0 && (
              <tr>
                <td colSpan={9} className="expanded-txns-cell">
                  <div className="tree-txns">
                    {expandedTxns.map((t) => {
                      const isReclassifying = reclassifyingId === t.id
                      return (
                        <div key={t.id} className="tree-txn-row">
                          <span className="dim">{t.date}</span>
                          <span className="tree-txn-desc">{t.description}</span>
                          <span className="dim">{t.category_path}</span>
                          <span className="num">{fmtDollar(t.amount)}</span>
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
                                if (e.key === 'Escape') {
                                  setReclassifyingId(null)
                                }
                              }}
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <button
                              className="reclassify-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                setReclassifyingId(t.id)
                                setReclassifyFeedback('')
                              }}
                            >?</button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  )
}
