import { useEffect, useMemo, useState } from 'react'
import Plot from 'react-plotly.js'
import type { MonthCategoryData, CategorySummary } from '../api'
import {
  fetchSpendingByMonthCategory,
  fetchSpendingByCategory,
  fetchSpendingBySubcategory,
} from '../api'

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
  const [subcategories, setSubcategories] = useState<CategorySummary[]>([])
  const [drillMonthData, setDrillMonthData] = useState<MonthCategoryData | null>(null)

  useEffect(() => {
    fetchSpendingByMonthCategory(12).then(setMonthCatData)
    fetchSpendingByCategory().then(setCategories)
  }, [])

  useEffect(() => {
    if (selectedCategory && selectedCategory !== 'Uncategorized') {
      fetchSpendingBySubcategory(selectedCategory).then(setSubcategories)
      fetchSpendingByMonthCategory(12, selectedCategory).then(setDrillMonthData)
    } else {
      setSubcategories([])
      setDrillMonthData(null)
    }
  }, [selectedCategory])

  const activeMonthData = selectedCategory && drillMonthData ? drillMonthData : monthCatData
  const activeCategories = selectedCategory && subcategories.length > 0
    ? subcategories
    : categories

  // Color map for the active chart view (drill-down or top-level)
  const colorMap = useMemo(() => {
    const allCats = new Set<string>()
    if (activeMonthData) activeMonthData.categories.forEach((c) => allCats.add(c))
    activeCategories.forEach((c) => allCats.add(c.category))
    const sorted = [...allCats].sort((a, b) => {
      const aTotal = activeCategories.find((c) => c.category === a)?.total ?? 0
      const bTotal = activeCategories.find((c) => c.category === b)?.total ?? 0
      return aTotal - bTotal
    })
    return buildColorMap(sorted)
  }, [activeMonthData, activeCategories])

  // Color map for top-level buttons (stable across drill-down)
  const topLevelColorMap = useMemo(() => {
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

  const topSubcategories = useMemo(
    () => [...subcategories].sort((a, b) => a.total - b.total).slice(0, 12),
    [subcategories],
  )

  const isDrilledIn = selectedCategory != null && topSubcategories.length > 0
  const displayedButtons = isDrilledIn ? topSubcategories : topCategories
  const buttonColorMap = isDrilledIn ? colorMap : topLevelColorMap

  // Early return AFTER all hooks
  if (!activeMonthData || activeMonthData.months.length === 0) return null

  const months = activeMonthData.months.map((m) => m.month as string)

  const traces: Plotly.Data[] = activeMonthData.categories.map((cat) => ({
    x: months,
    y: activeMonthData.months.map((m) => (m[cat] as number) || 0),
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
              <>
                <span style={{ fontWeight: 400, fontSize: '0.7em', color: 'rgba(255,255,255,0.4)' }}>
                  {' '}&mdash; {selectedCategory}
                </span>
                <button
                  className="drill-back-btn"
                  onClick={() => onCategoryChange(null)}
                >
                  &larr; All Categories
                </button>
              </>
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
          const totalSpend = displayedButtons.reduce((s, c) => s + Math.abs(c.total), 0)
          return displayedButtons.map((cat) => {
            const color = buttonColorMap[cat.category] || '#94a3b8'
            const isActive = !selectedCategory && cat.category === selectedCategory
            const pct = totalSpend > 0 ? (Math.abs(cat.total) / totalSpend) * 100 : 0
            return (
              <button
                key={cat.category}
                className={`category-btn ${isActive ? 'active' : ''}`}
                style={{
                  borderColor: isActive ? color : 'rgba(255,255,255,0.1)',
                  backgroundColor: isActive ? color + '22' : 'transparent',
                }}
                onClick={() => {
                  if (selectedCategory) {
                    onCategoryChange(null)
                  } else {
                    onCategoryChange(cat.category)
                  }
                }}
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
