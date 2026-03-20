import { useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TripSummary } from '../api'
import { fetchTravelTrips } from '../api'

const fmtFull = (v: number) =>
  `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmt = (v: number) => {
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return ''
  const s = new Date(start + 'T12:00:00')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const startStr = `${months[s.getMonth()]} ${s.getDate()}`
  if (!end || start === end) return startStr
  const e = new Date(end + 'T12:00:00')
  if (s.getMonth() === e.getMonth()) return `${startStr}-${e.getDate()}`
  return `${startStr} - ${months[e.getMonth()]} ${e.getDate()}`
}

export function TravelByTrip() {
  const [trips, setTrips] = useState<TripSummary[]>([])

  useEffect(() => {
    fetchTravelTrips().then(setTrips)
  }, [])

  if (trips.length === 0) return null

  const totalSpent = trips.reduce((s, t) => s + t.total, 0)
  const totalTxns = trips.reduce((s, t) => s + t.transaction_count, 0)

  // Chart data — show trips with spending, sorted by date
  const chartData = trips
    .filter((t) => t.name !== 'Other Travel')
    .map((t) => ({
      label: `${t.name} (${formatDateRange(t.start, t.end)})`,
      name: t.name,
      absTotal: Math.abs(t.total),
      dates: formatDateRange(t.start, t.end),
      txns: t.transaction_count,
      days: t.duration_days,
    }))

  const otherTravel = trips.find((t) => t.name === 'Other Travel')

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>Travel by Trip</h2>
          <p style={{ color: 'rgba(255,255,255,0.5)', margin: '4px 0 8px' }}>
            Spending matched to calendar trips
          </p>
          <div className="metric-row">
            <span className="metric negative">
              <span className="metric-label">Total Travel</span>
              <span className="metric-value">{fmtFull(totalSpent)}</span>
            </span>
            <span className="metric">
              <span className="metric-label">Trips</span>
              <span className="metric-value">{trips.length - (otherTravel ? 1 : 0)}</span>
            </span>
            <span className="metric">
              <span className="metric-label">Transactions</span>
              <span className="metric-value">{totalTxns}</span>
            </span>
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={Math.max(300, chartData.length * 28)}>
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 10, right: 30, left: 200, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis
            type="number"
            tickFormatter={fmt}
            stroke="rgba(255,255,255,0.3)"
            tick={{ fontSize: 11 }}
          />
          <YAxis
            type="category"
            dataKey="label"
            stroke="rgba(255,255,255,0.3)"
            tick={{ fontSize: 11 }}
            width={190}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e1e3f',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
            }}
            formatter={(value: number, _: string, props: { payload: typeof chartData[0] }) => {
              const d = props.payload
              return [
                `${fmtFull(value)} (${d.txns} txns${d.days ? `, ${d.days}d` : ''})`,
                d.name,
              ]
            }}
            labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
          />
          <Bar dataKey="absTotal" name="Spent" radius={[0, 4, 4, 0]}>
            {chartData.map((_, i) => (
              <Cell key={i} fill={`hsl(${200 + i * 11}, 65%, 60%)`} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {otherTravel && otherTravel.transaction_count > 0 && (
        <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 8, textAlign: 'right' }}>
          + {fmtFull(otherTravel.total)} in {otherTravel.transaction_count} unmatched travel transactions
        </p>
      )}
    </section>
  )
}
