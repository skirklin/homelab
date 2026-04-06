import { useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { PerformancePoint } from '../api'
import { fetchPerformance } from '../api'
import { TimeRangeSelector, type TimeRange, getStartDate } from './TimeRangeSelector'

const COLORS = ['#818cf8', '#34d399', '#fb923c', '#f472b6', '#38bdf8', '#a78bfa']

const fmt = (v: number) => {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

const fmtFull = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function PerformanceChart() {
  const [data, setData] = useState<PerformancePoint[]>([])
  const [range, setRange] = useState<TimeRange>('ALL')

  useEffect(() => {
    const start = getStartDate(range)
    fetchPerformance().then((series) => {
      setData(start ? series.filter((s) => s.date >= start) : series)
    })
  }, [range])

  if (data.length === 0) return null

  // Pivot: per date, show invested vs balance for each account
  const accountIds = [...new Set(data.map((d) => d.account_id))]
  const accountNames: Record<string, string> = {}
  for (const d of data) {
    accountNames[d.account_id] = `${d.institution} — ${d.account_name}`
  }

  // Aggregate: total invested vs total balance by date
  const byDate: Record<string, { balance: number; invested: number }> = {}
  for (const d of data) {
    if (!byDate[d.date]) byDate[d.date] = { balance: 0, invested: 0 }
    byDate[d.date].balance += d.balance
    byDate[d.date].invested += d.invested ?? 0
  }

  const chartData = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({
      date,
      balance: vals.balance,
      invested: vals.invested,
      earned: vals.balance - vals.invested,
    }))

  const latest = chartData[chartData.length - 1]

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>Investment Performance</h2>
          {latest && (
            <div className="metric-row">
              <span className="metric">
                <span className="metric-label">Balance</span>
                <span className="metric-value">{fmtFull(latest.balance)}</span>
              </span>
              <span className="metric">
                <span className="metric-label">Invested</span>
                <span className="metric-value">{fmtFull(latest.invested)}</span>
              </span>
              <span className="metric positive">
                <span className="metric-label">Earned</span>
                <span className="metric-value">+{fmtFull(latest.earned)}</span>
              </span>
            </div>
          )}
        </div>
        <TimeRangeSelector value={range} onChange={setRange} />
      </div>
      <ResponsiveContainer width="100%" height={400}>
        <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis dataKey="date" stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={fmt} stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 11 }} width={70} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1e1e3f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
            formatter={(value: number, name: string) => [fmtFull(value), name]}
            labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
          />
          <Legend />
          <Area type="monotone" dataKey="invested" name="Total Invested" stackId="1"
            stroke="#818cf8" fill="#818cf8" fillOpacity={0.4} />
          <Area type="monotone" dataKey="earned" name="Investment Gains" stackId="1"
            stroke="#34d399" fill="#34d399" fillOpacity={0.4} />
        </AreaChart>
      </ResponsiveContainer>
    </section>
  )
}
