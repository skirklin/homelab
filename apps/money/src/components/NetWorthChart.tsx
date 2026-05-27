import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
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

type ViewMode = 'liquid' | 'with_equity' | 'breakdown'

const DEFAULT_RANGE: TimeRange = '1Y'
const DEFAULT_VIEW: ViewMode = 'liquid'

const RANGE_VALUES: TimeRange[] = ['1M', '3M', '6M', '1Y', '5Y', 'ALL']
const VIEW_VALUES: ViewMode[] = ['liquid', 'with_equity', 'breakdown']

export function NetWorthChart() {
  const [data, setData] = useState<NetWorthPoint[]>([])
  const [searchParams, setSearchParams] = useSearchParams()

  const rawRange = searchParams.get('nwRange')
  const range: TimeRange = RANGE_VALUES.includes(rawRange as TimeRange)
    ? (rawRange as TimeRange)
    : DEFAULT_RANGE
  const rawView = searchParams.get('nwView')
  const view: ViewMode = VIEW_VALUES.includes(rawView as ViewMode)
    ? (rawView as ViewMode)
    : DEFAULT_VIEW

  const setRange = useCallback((next: TimeRange) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next === DEFAULT_RANGE) params.delete('nwRange')
      else params.set('nwRange', next)
      return params
    }, { replace: true })
  }, [setSearchParams])

  const setView = useCallback((next: ViewMode) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next === DEFAULT_VIEW) params.delete('nwView')
      else params.set('nwView', next)
      return params
    }, { replace: true })
  }, [setSearchParams])

  useEffect(() => {
    const start = getStartDate(range)
    fetchNetWorthHistory(start).then(setData)
  }, [range])

  if (data.length === 0) return null

  const latest = data[data.length - 1]
  const first = data[0]

  const displayValue = view === 'liquid' ? latest.liquid : latest.net_worth
  const startValue = view === 'liquid' ? first.liquid : first.net_worth
  const change = displayValue - startValue
  const changePct = startValue > 0 ? (change / startValue) * 100 : 0
  const hasEquity = data.some((d) => d.equity > 0)

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>Net Worth</h2>
          <div className="metric-row">
            <span className="big-number">{fmtFull(displayValue)}</span>
            {startValue > 0 && (
              <span className={`change ${change >= 0 ? 'positive' : 'negative'}`}>
                {change >= 0 ? '+' : ''}
                {fmtFull(change)} ({changePct >= 0 ? '+' : ''}
                {changePct.toFixed(1)}%)
              </span>
            )}
          </div>
        </div>
        <div className="controls">
          {hasEquity && (
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                className={`toggle-btn ${view === 'liquid' ? 'active' : ''}`}
                onClick={() => setView('liquid')}
              >
                Liquid
              </button>
              <button
                className={`toggle-btn ${view === 'with_equity' ? 'active' : ''}`}
                onClick={() => setView('with_equity')}
              >
                + Equity
              </button>
              <button
                className={`toggle-btn ${view === 'breakdown' ? 'active' : ''}`}
                onClick={() => setView('breakdown')}
              >
                Breakdown
              </button>
            </div>
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
            formatter={(value, name) => {
              const n = typeof value === 'number' ? value : Number(value)
              const label = typeof name === 'string' ? name : String(name ?? '')
              return [Number.isFinite(n) ? fmtFull(n) : '—', label]
            }}
            labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
          />
          {view === 'liquid' && (
            <Area type="monotone" dataKey="liquid" name="Liquid Net Worth"
              stroke="#818cf8" fill="#818cf8" fillOpacity={0.2} />
          )}
          {view === 'with_equity' && (
            <>
              <Area type="monotone" dataKey="liquid" name="Liquid" stackId="1"
                stroke="#818cf8" fill="#818cf8" fillOpacity={0.3} />
              <Area type="monotone" dataKey="equity" name="Equity" stackId="1"
                stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.2} />
            </>
          )}
          {view === 'breakdown' && (
            <>
              <Area type="monotone" dataKey="invested" name="Invested" stackId="1"
                stroke="#818cf8" fill="#818cf8" fillOpacity={0.4} />
              <Area type="monotone" dataKey="earned" name="Earned" stackId="1"
                stroke="#34d399" fill="#34d399" fillOpacity={0.4} />
            </>
          )}
        </AreaChart>
      </ResponsiveContainer>
    </section>
  )
}
