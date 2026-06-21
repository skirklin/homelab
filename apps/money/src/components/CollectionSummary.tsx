import { useEffect, useState } from 'react'
import Plot from 'react-plotly.js'
import type { Data as PlotlyData } from 'plotly.js'
import type { CollectionInfo, CollectionMonthSummary } from '../api'
import { fetchCollections, fetchCollectionByMonth } from '../api'
import { fmtDollarWhole as fmtDollar } from '@kirkl/shared'

const THEME = {
  cardBg: '#1e1e3f',
  border: 'rgba(255,255,255,0.1)',
  textMuted: 'rgba(255,255,255,0.4)',
  text: 'rgba(255,255,255,0.7)',
  grid: 'rgba(255,255,255,0.06)',
}

function CollectionDetail({ collection }: { collection: CollectionInfo }) {
  const [months, setMonths] = useState<CollectionMonthSummary[]>([])

  useEffect(() => {
    fetchCollectionByMonth(collection.id).then(setMonths)
  }, [collection.id])

  const totalSpent = months.reduce((s, m) => s + m.total, 0)

  const traces: PlotlyData[] = [
    {
      x: months.map((m) => m.month),
      y: months.map((m) => Math.abs(m.total)),
      type: 'bar' as const,
      marker: { color: '#818cf8' },
      hovertemplate: `<b>%{x}</b><br>$%{y:,.0f}<extra></extra>`,
    },
  ]

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>{collection.label}</h2>
          <p style={{ color: THEME.textMuted, margin: '4px 0 8px', fontSize: 13 }}>
            {collection.description}
          </p>
          <div className="metric-row">
            <span className="metric negative">
              <span className="metric-label">Total</span>
              <span className="metric-value">{fmtDollar(totalSpent)}</span>
            </span>
          </div>
        </div>
      </div>
      {months.length > 0 && (
        <Plot
          data={traces}
          layout={{
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { color: THEME.text, size: 11 },
            margin: { l: 60, r: 20, t: 10, b: 30 },
            xaxis: {
              type: 'category',
              gridcolor: THEME.grid,
              linecolor: THEME.grid,
              tickfont: { color: THEME.textMuted, size: 11 },
            },
            yaxis: {
              gridcolor: THEME.grid,
              linecolor: THEME.grid,
              tickprefix: '$',
              separatethousands: true,
              tickfont: { color: THEME.textMuted, size: 11 },
            },
            showlegend: false,
            hoverlabel: {
              bgcolor: THEME.cardBg,
              bordercolor: THEME.border,
              font: { color: THEME.text, size: 12 },
            },
            bargap: 0.3,
          }}
          config={{ responsive: true, displayModeBar: false }}
          useResizeHandler
          style={{ width: '100%', height: 200 }}
        />
      )}
    </section>
  )
}

export function SpendingCollections() {
  const [collections, setCollections] = useState<CollectionInfo[]>([])

  useEffect(() => {
    fetchCollections().then(setCollections)
  }, [])

  if (collections.length === 0) return null

  return (
    <>
      {collections.map((c) => (
        <CollectionDetail key={c.id} collection={c} />
      ))}
    </>
  )
}
