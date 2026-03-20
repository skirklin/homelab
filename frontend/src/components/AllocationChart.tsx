import { useEffect, useState } from 'react'
import Plot from 'react-plotly.js'
import type { AllocationItem } from '../api'
import { fetchAllocation } from '../api'

const fmtDollar = (v: number) =>
  `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

const BROAD_COLORS: Record<string, string> = {
  'US Equities': '#818cf8',
  "Int'l Equities": '#34d399',
  'Bonds': '#fbbf24',
  'Real Estate': '#fb923c',
  'Commodities': '#f472b6',
}

export function AllocationChart() {
  const [data, setData] = useState<AllocationItem[]>([])
  const [view, setView] = useState<'broad' | 'detailed'>('broad')

  useEffect(() => {
    fetchAllocation().then(setData)
  }, [])

  if (data.length === 0) return null

  const totalValue = data.reduce((s, d) => s + d.value, 0)

  // Aggregate by broad class for the simple view
  const byBroad: Record<string, number> = {}
  for (const item of data) {
    byBroad[item.broad_class] = (byBroad[item.broad_class] ?? 0) + item.value
  }
  const broadSorted = Object.entries(byBroad).sort((a, b) => b[1] - a[1])

  // Detailed view uses full asset_class
  const detailedSorted = [...data]
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)

  const items = view === 'broad' ? broadSorted : detailedSorted.map((d) => [d.asset_class, d.value] as [string, number])

  const labels = items.map(([name]) => name)
  const values = items.map(([, val]) => val)
  const colors = items.map(([name]) => {
    if (view === 'broad') return BROAD_COLORS[name] ?? '#94a3b8'
    // For detailed, use the broad class color
    const item = data.find((d) => d.asset_class === name)
    return BROAD_COLORS[item?.broad_class ?? ''] ?? '#94a3b8'
  })

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>Asset Allocation</h2>
          <div className="metric-row">
            <span className="metric">
              <span className="metric-label">Total Invested</span>
              <span className="metric-value">{fmtDollar(totalValue)}</span>
            </span>
          </div>
        </div>
        <div className="controls">
          <div className="time-range-selector">
            <button
              className={`range-btn ${view === 'broad' ? 'active' : ''}`}
              onClick={() => setView('broad')}
            >
              Broad
            </button>
            <button
              className={`range-btn ${view === 'detailed' ? 'active' : ''}`}
              onClick={() => setView('detailed')}
            >
              Detailed
            </button>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div style={{ flex: '0 0 380px' }}>
          <Plot
            data={[
              {
                labels,
                values,
                type: 'pie',
                hole: 0.45,
                marker: { colors },
                textinfo: view === 'broad' ? 'label+percent' : 'percent',
                textposition: view === 'broad' ? 'outside' : 'inside',
                textfont: { color: 'rgba(255,255,255,0.7)', size: view === 'broad' ? 12 : 9 },
                hovertemplate: '%{label}<br>%{value:$,.0f} (%{percent})<extra></extra>',
                sort: false,
              },
            ]}
            layout={{
              paper_bgcolor: 'transparent',
              plot_bgcolor: 'transparent',
              font: { color: 'rgba(255,255,255,0.6)', size: 11 },
              margin: { l: 60, r: 60, t: 20, b: 20 },
              showlegend: false,
              hoverlabel: {
                bgcolor: '#1e1e3f',
                bordercolor: 'rgba(255,255,255,0.1)',
                font: { color: 'rgba(255,255,255,0.8)', size: 12 },
              },
            }}
            config={{ responsive: true, displayModeBar: false }}
            useResizeHandler
            style={{ width: '100%', height: 320 }}
          />
        </div>
        <div style={{ flex: 1, fontSize: 13 }}>
          <table className="portfolio-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Asset Class</th>
                <th className="right">Value</th>
                <th className="right">%</th>
              </tr>
            </thead>
            <tbody>
              {items.map(([name, val]) => {
                const pct = totalValue > 0 ? (val / totalValue) * 100 : 0
                const item = data.find((d) => d.asset_class === name)
                const color = view === 'broad'
                  ? BROAD_COLORS[name] ?? '#94a3b8'
                  : BROAD_COLORS[item?.broad_class ?? ''] ?? '#94a3b8'
                return (
                  <tr key={name}>
                    <td>
                      <span style={{
                        display: 'inline-block',
                        width: 8, height: 8,
                        borderRadius: '50%',
                        backgroundColor: color,
                        marginRight: 8,
                      }} />
                      {name}
                    </td>
                    <td className="amount right">{fmtDollar(val)}</td>
                    <td className="amount right" style={{ color: 'rgba(255,255,255,0.4)' }}>
                      {pct.toFixed(1)}%
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
