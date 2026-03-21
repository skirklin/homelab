import { useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { NetWorthPoint } from '../api'
import { fetchNetWorthHistory } from '../api'
import { TimeRangeSelector, type TimeRange, getStartDate } from './TimeRangeSelector'

const fmt = (v: number) => {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

const fmtFull = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function NetWorthChart() {
  const [data, setData] = useState<NetWorthPoint[]>([])
  const [range, setRange] = useState<TimeRange>('1Y')
  const [showBreakdown, setShowBreakdown] = useState(false)

  useEffect(() => {
    const start = getStartDate(range)
    fetchNetWorthHistory(start).then(setData)
  }, [range])

  if (data.length === 0) return null

  const latest = data[data.length - 1]
  const first = data[0]
  const change = latest.net_worth - first.net_worth
  const changePct = first.net_worth > 0 ? (change / first.net_worth) * 100 : 0
  const hasInvestedData = data.some((d) => d.invested != null)

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>Net Worth</h2>
          <div className="metric-row">
            <span className="big-number">{fmtFull(latest.net_worth)}</span>
            {first.net_worth > 0 && (
              <span className={`change ${change >= 0 ? 'positive' : 'negative'}`}>
                {change >= 0 ? '+' : ''}
                {fmtFull(change)} ({changePct >= 0 ? '+' : ''}
                {changePct.toFixed(1)}%)
              </span>
            )}
          </div>
        </div>
        <div className="controls">
          {hasInvestedData && (
            <button
              className={`toggle-btn ${showBreakdown ? 'active' : ''}`}
              onClick={() => setShowBreakdown(!showBreakdown)}
            >
              Invested vs Earned
            </button>
          )}
          <TimeRangeSelector value={range} onChange={setRange} />
        </div>
      </div>
      <ResponsiveContainer width="100%" height={400}>
        <AreaChart data={data} margin={{ top: 10, right: 30, left: 20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis dataKey="date" stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={fmt} stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 11 }} width={70} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1e1e3f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
            formatter={(value: number, name: string) => [fmtFull(value), name]}
            labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
          />
          {showBreakdown ? (
            <>
              <Area type="monotone" dataKey="invested" name="Invested" stackId="1"
                stroke="#818cf8" fill="#818cf8" fillOpacity={0.4} />
              <Area type="monotone" dataKey="earned" name="Earned" stackId="1"
                stroke="#34d399" fill="#34d399" fillOpacity={0.4} />
            </>
          ) : (
            <Area type="monotone" dataKey="net_worth" name="Net Worth"
              stroke="#818cf8" fill="#818cf8" fillOpacity={0.2} />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </section>
  )
}
