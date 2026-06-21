import { useEffect, useState } from 'react'
import Plot from 'react-plotly.js'
import type { Data as PlotlyData } from 'plotly.js'
import type { TripSummary } from '../api'
import { fetchTravelTrips } from '../api'
import { fmtDollarWhole as fmtDollar } from '@kirkl/shared'

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return ''
  const s = new Date(start + 'T12:00:00')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const startStr = `${months[s.getMonth()]} ${s.getDate()}`
  if (!end || start === end) return startStr
  const e = new Date(end + 'T12:00:00')
  if (s.getMonth() === e.getMonth()) return `${startStr}–${e.getDate()}`
  return `${startStr} – ${months[e.getMonth()]} ${e.getDate()}`
}

const THEME = {
  cardBg: '#1e1e3f',
  border: 'rgba(255,255,255,0.1)',
  textMuted: 'rgba(255,255,255,0.4)',
  text: 'rgba(255,255,255,0.7)',
  grid: 'rgba(255,255,255,0.06)',
}

export function TravelByTrip() {
  const [trips, setTrips] = useState<TripSummary[]>([])

  useEffect(() => {
    fetchTravelTrips().then(setTrips)
  }, [])

  if (trips.length === 0) return null

  const totalSpent = trips.reduce((s, t) => s + t.total, 0)
  const namedTrips = trips.filter((t) => t.name !== 'Other Travel')
  const otherTravel = trips.find((t) => t.name === 'Other Travel')

  // Horizontal bar — keep the same orientation the ECharts version used:
  // reverse so the most-recent trip (top of input) sits at the top of the
  // chart. Plotly's category axis renders the first value at the bottom,
  // so we reverse to flip that.
  const chartTrips = trips
    .filter((t) => t.name !== 'Other Travel' && Math.abs(t.total) > 50)
    .reverse()

  const labels = chartTrips.map(
    (t) => `${t.name}  ${formatDateRange(t.start, t.end)}`,
  )
  const values = chartTrips.map((t) => Math.abs(t.total))
  const colors = chartTrips.map((_, i) => `hsl(${200 + i * 11}, 65%, 60%)`)

  // Pack the per-trip metadata into customdata so the hovertemplate can
  // read from it without closing over chartTrips at render time.
  const customdata = chartTrips.map((t) => [
    t.name,
    formatDateRange(t.start, t.end),
    t.duration_days ? `${t.duration_days}d` : '',
    String(t.transaction_count),
  ])

  const traces: PlotlyData[] = [
    {
      x: values,
      y: labels,
      type: 'bar' as const,
      orientation: 'h' as const,
      marker: { color: colors },
      customdata,
      hovertemplate:
        '<b>%{customdata[0]}</b><br>' +
        '%{customdata[1]} %{customdata[2]}<br>' +
        '$%{x:,.0f} · %{customdata[3]} transactions' +
        '<extra></extra>',
    },
  ]

  const chartHeight = Math.max(300, chartTrips.length * 30)

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>Travel by Trip</h2>
          <p style={{ color: THEME.textMuted, margin: '4px 0 8px', fontSize: 13 }}>
            Spending matched to calendar trips
          </p>
          <div className="metric-row">
            <span className="metric negative">
              <span className="metric-label">Total Travel</span>
              <span className="metric-value">{fmtDollar(totalSpent)}</span>
            </span>
            <span className="metric">
              <span className="metric-label">Trips</span>
              <span className="metric-value">{namedTrips.length}</span>
            </span>
          </div>
        </div>
      </div>
      <Plot
        data={traces}
        layout={{
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          font: { color: THEME.text, size: 11 },
          margin: { l: 180, r: 30, t: 10, b: 30 },
          xaxis: {
            tickprefix: '$',
            separatethousands: true,
            gridcolor: THEME.grid,
            linecolor: THEME.grid,
            tickfont: { color: THEME.textMuted, size: 11 },
            zeroline: false,
          },
          yaxis: {
            type: 'category',
            gridcolor: THEME.grid,
            linecolor: THEME.grid,
            tickfont: { color: THEME.text, size: 11 },
            automargin: false,
          },
          showlegend: false,
          hoverlabel: {
            bgcolor: THEME.cardBg,
            bordercolor: THEME.border,
            font: { color: THEME.text, size: 12 },
          },
          bargap: 0.35,
        }}
        config={{ responsive: true, displayModeBar: false }}
        useResizeHandler
        style={{ width: '100%', height: chartHeight }}
      />
      {otherTravel && otherTravel.transaction_count > 0 && (
        <p style={{ color: THEME.textMuted, fontSize: 11, marginTop: 4, textAlign: 'right' }}>
          + {fmtDollar(otherTravel.total)} in {otherTravel.transaction_count} unmatched transactions
        </p>
      )}
    </section>
  )
}
