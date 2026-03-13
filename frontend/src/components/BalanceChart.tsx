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
import type { Account, BalancePoint } from '../api'

interface Props {
  balances: BalancePoint[]
  accounts: Account[]
}

const COLORS = [
  '#818cf8', // indigo
  '#34d399', // emerald
  '#fb923c', // orange
  '#f472b6', // pink
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#fbbf24', // amber
  '#4ade80', // green
]

function formatDollar(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

export function BalanceChart({ balances, accounts }: Props) {
  if (balances.length === 0) {
    return <div style={{ textAlign: 'center', padding: '4rem', opacity: 0.5 }}>No balance data yet</div>
  }

  // Pivot: each date becomes a row with columns per account
  const accountIds = [...new Set(balances.map((b) => b.account_id))]
  const accountNames: Record<string, string> = {}
  for (const b of balances) {
    accountNames[b.account_id] = `${b.institution} — ${b.account_name}`
  }

  // Group by date
  const byDate: Record<string, Record<string, number>> = {}
  for (const b of balances) {
    if (!byDate[b.date]) byDate[b.date] = {}
    byDate[b.date][b.account_id] = b.balance
  }

  // Build chart data: fill forward missing values
  const dates = Object.keys(byDate).sort()
  const lastKnown: Record<string, number> = {}
  const chartData = dates.map((d) => {
    const row: Record<string, string | number> = { date: d }
    for (const id of accountIds) {
      if (byDate[d][id] !== undefined) {
        lastKnown[id] = byDate[d][id]
      }
      if (lastKnown[id] !== undefined) {
        row[id] = lastKnown[id]
      }
    }
    return row
  })

  return (
    <div>
      <h2 style={{ fontSize: '1.1em', fontWeight: 400, opacity: 0.7, marginBottom: '1rem' }}>
        Balance History
      </h2>
      <ResponsiveContainer width="100%" height={500}>
        <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
          <XAxis
            dataKey="date"
            stroke="rgba(255,255,255,0.4)"
            tick={{ fontSize: 12 }}
          />
          <YAxis
            tickFormatter={formatDollar}
            stroke="rgba(255,255,255,0.4)"
            tick={{ fontSize: 12 }}
            width={70}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e1e3f',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
            }}
            formatter={(value: number) =>
              `$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
            }
            labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
          />
          <Legend />
          {accountIds.map((id, i) => (
            <Area
              key={id}
              type="monotone"
              dataKey={id}
              name={accountNames[id]}
              stackId="1"
              stroke={COLORS[i % COLORS.length]}
              fill={COLORS[i % COLORS.length]}
              fillOpacity={0.3}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
