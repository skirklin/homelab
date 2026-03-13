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
import type { MonthSummary, CategorySummary } from '../api'
import { fetchSpendingByMonth, fetchSpendingByCategory } from '../api'

const fmt = (v: number) => {
  const abs = Math.abs(v)
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

const fmtFull = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

export function SpendingByMonth() {
  const [data, setData] = useState<MonthSummary[]>([])

  useEffect(() => {
    fetchSpendingByMonth().then(setData)
  }, [])

  if (data.length === 0) return null

  const avgSpending = data.reduce((s, d) => s + d.spending, 0) / data.length
  const avgIncome = data.reduce((s, d) => s + d.income, 0) / data.length

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>Monthly Cash Flow</h2>
          <div className="metric-row">
            <span className="metric positive">
              <span className="metric-label">Avg Income</span>
              <span className="metric-value">{fmtFull(avgIncome)}</span>
            </span>
            <span className="metric negative">
              <span className="metric-label">Avg Spending</span>
              <span className="metric-value">{fmtFull(avgSpending)}</span>
            </span>
            <span className="metric">
              <span className="metric-label">Avg Net</span>
              <span className="metric-value">{fmtFull(avgIncome + avgSpending)}</span>
            </span>
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} margin={{ top: 10, right: 30, left: 20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis dataKey="month" stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={fmt} stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 11 }} width={60} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1e1e3f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
            formatter={(value: number, name: string) => [fmtFull(value), name]}
            labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
          />
          <Bar dataKey="income" name="Income" fill="#34d399" radius={[4, 4, 0, 0]} />
          <Bar dataKey="spending" name="Spending" fill="#f87171" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </section>
  )
}

export function SpendingByCategory() {
  const [data, setData] = useState<CategorySummary[]>([])

  useEffect(() => {
    fetchSpendingByCategory().then((cats) => {
      // Take top 15 by absolute value, group rest
      const sorted = [...cats].sort((a, b) => a.total - b.total)
      const top = sorted.slice(0, 15)
      const rest = sorted.slice(15)
      if (rest.length > 0) {
        top.push({
          category: `Other (${rest.length} categories)`,
          total: rest.reduce((s, c) => s + c.total, 0),
          count: rest.reduce((s, c) => s + c.count, 0),
        })
      }
      setData(top)
    })
  }, [])

  if (data.length === 0) return null

  const chartData = data.map((d) => ({
    ...d,
    category: truncate(d.category ?? 'Unknown', 30),
    absTotal: Math.abs(d.total),
  }))

  return (
    <section className="chart-section">
      <h2>Top Spending Categories</h2>
      <ResponsiveContainer width="100%" height={Math.max(300, data.length * 28)}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 10, right: 30, left: 160, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis type="number" tickFormatter={fmt} stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="category" stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 11 }} width={150} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1e1e3f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
            formatter={(value: number) => [fmtFull(-value), 'Total Spent']}
            labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
          />
          <Bar dataKey="absTotal" name="Amount" radius={[0, 4, 4, 0]}>
            {chartData.map((_, i) => (
              <Cell key={i} fill={`hsl(${220 + i * 8}, 70%, 65%)`} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </section>
  )
}
