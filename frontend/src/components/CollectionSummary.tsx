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
import type { CollectionInfo, CollectionMonthSummary, CategorySummary } from '../api'
import { fetchCollections, fetchCollectionByMonth, fetchCollectionByCategory } from '../api'

const fmt = (v: number) => {
  const abs = Math.abs(v)
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

const fmtFull = (v: number) =>
  `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

function CollectionDetail({ collection }: { collection: CollectionInfo }) {
  const [months, setMonths] = useState<CollectionMonthSummary[]>([])
  const [categories, setCategories] = useState<CategorySummary[]>([])

  useEffect(() => {
    fetchCollectionByMonth(collection.id).then(setMonths)
    fetchCollectionByCategory(collection.id).then(setCategories)
  }, [collection.id])

  const totalSpent = months.reduce((s, m) => s + m.total, 0)
  const totalTxns = months.reduce((s, m) => s + m.count, 0)
  const chartMonths = months.map((m) => ({ ...m, absTotal: Math.abs(m.total) }))
  const chartCats = categories
    .sort((a, b) => a.total - b.total)
    .slice(0, 10)
    .map((c) => ({
      ...c,
      category: truncate(c.category ?? 'Unknown', 35),
      absTotal: Math.abs(c.total),
    }))

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>{collection.label}</h2>
          <p style={{ color: 'rgba(255,255,255,0.5)', margin: '4px 0 8px' }}>
            {collection.description}
          </p>
          <div className="metric-row">
            <span className="metric negative">
              <span className="metric-label">Total Spent</span>
              <span className="metric-value">{fmtFull(totalSpent)}</span>
            </span>
            <span className="metric">
              <span className="metric-label">Transactions</span>
              <span className="metric-value">{totalTxns}</span>
            </span>
          </div>
        </div>
      </div>

      {chartMonths.length > 0 && (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartMonths} margin={{ top: 10, right: 30, left: 20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="month" stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 11 }} />
            <YAxis
              tickFormatter={fmt}
              stroke="rgba(255,255,255,0.3)"
              tick={{ fontSize: 11 }}
              width={60}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1e1e3f',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
              }}
              formatter={(value: number) => [fmtFull(value), 'Spent']}
              labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
            />
            <Bar dataKey="absTotal" name="Spent" fill="#818cf8" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}

      {chartCats.length > 0 && (
        <ResponsiveContainer width="100%" height={Math.max(150, chartCats.length * 28)}>
          <BarChart
            data={chartCats}
            layout="vertical"
            margin={{ top: 10, right: 30, left: 160, bottom: 0 }}
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
              dataKey="category"
              stroke="rgba(255,255,255,0.3)"
              tick={{ fontSize: 11 }}
              width={150}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1e1e3f',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
              }}
              formatter={(value: number) => [fmtFull(value), 'Total']}
              labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
            />
            <Bar dataKey="absTotal" name="Amount" radius={[0, 4, 4, 0]}>
              {chartCats.map((_, i) => (
                <Cell key={i} fill={`hsl(${250 + i * 12}, 70%, 65%)`} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
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
