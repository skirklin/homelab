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
  selectedCategory: string | null
  onCategoryChange: (category: string | null) => void
  onBarClick?: (month: string, category: string) => void
}

export function SpendingCharts({
  selectedCategory,
  onCategoryChange,
  onBarClick,
}: SpendingChartsProps) {
  const [monthCatData, setMonthCatData] = useState<MonthCategoryData | null>(null)
  const [categories, setCategories] = useState<CategorySummary[]>([])

  useEffect(() => {
    fetchSpendingByMonthCategory(12).then(setMonthCatData)
    fetchSpendingByCategory().then(setCategories)
  }, [])

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
  const visibleCats = selectedCategory
    ? monthCatData.categories.filter((c) => c === selectedCategory)
    : monthCatData.categories

  const traces: Plotly.Data[] = visibleCats.map((cat) => ({
    x: months,
    y: monthCatData.months.map((m) => (m[cat] as number) || 0),
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
            Monthly Spending
            {selectedCategory && (
              <span style={{ fontWeight: 400, fontSize: '0.7em', color: 'rgba(255,255,255,0.4)' }}>
                {' '}&mdash; {selectedCategory}
              </span>
            )}
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

      <div className="category-buttons">
        {(() => {
          const totalSpend = topCategories.reduce((s, c) => s + Math.abs(c.total), 0)
          return topCategories.map((cat) => {
            const color = colorMap[cat.category] || '#94a3b8'
            const isActive = selectedCategory === cat.category
            const pct = totalSpend > 0 ? (Math.abs(cat.total) / totalSpend) * 100 : 0
            return (
              <button
                key={cat.category}
                className={`category-btn ${isActive ? 'active' : ''}`}
                style={{
                  borderColor: isActive ? color : 'rgba(255,255,255,0.1)',
                  backgroundColor: isActive ? color + '22' : 'transparent',
                }}
                onClick={() => onCategoryChange(isActive ? null : cat.category)}
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
    </>
  )
}
