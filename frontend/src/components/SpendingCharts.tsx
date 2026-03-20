import { useEffect, useMemo, useState } from 'react'
import Plot from 'react-plotly.js'
import type { MonthCategoryData, CategorySummary } from '../api'
import { fetchSpendingByMonthCategory, fetchSpendingByCategory } from '../api'

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

interface SpendingChartsProps {
  /** Current category path prefix, e.g. null, "Housing", "Housing/Utilities" */
  prefix: string | null
  onPrefixChange: (prefix: string | null) => void
  onBarClick?: (month: string, category: string) => void
}

export function SpendingCharts({
  prefix,
  onPrefixChange,
  onBarClick,
}: SpendingChartsProps) {
  const [monthCatData, setMonthCatData] = useState<MonthCategoryData | null>(null)
  const [categories, setCategories] = useState<CategorySummary[]>([])

  useEffect(() => {
    fetchSpendingByMonthCategory(12, prefix ?? undefined).then(setMonthCatData)
    fetchSpendingByCategory(prefix ?? undefined).then(setCategories)
  }, [prefix])

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

  const topCategories = useMemo(
    () => [...categories].sort((a, b) => a.total - b.total).slice(0, 12),
    [categories],
  )

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

  // Build breadcrumb segments from the prefix
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
              Spending
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

      {topCategories.length > 1 && (
        <div className="category-buttons">
          {(() => {
            const totalSpend = topCategories.reduce((s, c) => s + Math.abs(c.total), 0)
            return topCategories.map((cat) => {
              const color = colorMap[cat.category] || '#94a3b8'
              const pct = totalSpend > 0 ? (Math.abs(cat.total) / totalSpend) * 100 : 0
              const childPrefix = prefix ? `${prefix}/${cat.category}` : cat.category
              return (
                <button
                  key={cat.category}
                  className="category-btn"
                  style={{
                    borderColor: 'rgba(255,255,255,0.1)',
                  }}
                  onClick={() => onPrefixChange(childPrefix)}
                >
                  <span className="category-btn-dot" style={{ backgroundColor: color }} />
                  <span className="category-btn-name">{cat.category}</span>
                  <span className="category-btn-amount">
                    {fmtDollar(cat.total)} &middot; {pct.toFixed(0)}%
                  </span>
                </button>
              )
            })
          })()}
        </div>
      )}
    </>
  )
}
