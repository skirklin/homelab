import { useEffect, useMemo, useState } from 'react'
import type { Account, PerformancePoint } from '../api'
import { fetchAccounts, fetchGrants, fetchPerformance } from '../api'
import { AllocationChart } from '../components/AllocationChart'
import { AllocationOverTime } from '../components/AllocationOverTime'
import { GrantsDetail } from '../components/GrantsDetail'
import { PerformanceVsBenchmark } from '../components/PerformanceVsBenchmark'

const fmtDollar = (v: number) => {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`
  return `${sign}$${abs.toFixed(2)}`
}

const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`

const INST_COLORS: Record<string, string> = {
  betterment: '#818cf8',
  wealthfront: '#34d399',
  ally: '#fb923c',
  'morgan stanley': '#f472b6',
  'capital one': '#38bdf8',
}

const TYPE_LABELS: Record<string, string> = {
  brokerage: 'Brokerage',
  ira: 'IRA',
  '401k': '401(k)',
  savings: 'Savings',
  checking: 'Checking',
  credit_card: 'Credit Card',
  stock_options: 'Stock Options',
  real_estate: 'Real Estate',
}

interface AccountWithPerf extends Account {
  returnPct: number | null
  notional_value?: number
}

function getStartDate(range: string): string {
  const now = new Date()
  const offsets: Record<string, number> = { '1Y': 1, '3Y': 3, '5Y': 5, 'ALL': 30 }
  const years = offsets[range] ?? 3
  return new Date(now.getFullYear() - years, now.getMonth(), now.getDate())
    .toISOString().slice(0, 10)
}

/** Compute period return for an account from performance history */
function periodReturn(
  points: PerformancePoint[],
  startDate: string,
): { earned: number; invested: number; returnPct: number } | null {
  const filtered = points.filter((p) => p.date >= startDate).sort((a, b) => a.date.localeCompare(b.date))
  if (filtered.length < 2) return null
  const first = filtered[0]
  const last = filtered[filtered.length - 1]
  if (first.invested == null || last.invested == null) return null
  const earned = (last.earned ?? 0) - (first.earned ?? 0)
  const invested = (last.invested ?? 0) - (first.invested ?? 0)
  // Use average invested capital as denominator for a fairer return calc
  const avgInvested = ((first.invested ?? 0) + (last.invested ?? 0)) / 2
  const returnPct = avgInvested > 0 ? (earned / avgInvested) * 100 : 0
  return { earned, invested, returnPct }
}

export function Investments() {
  const [accounts, setAccounts] = useState<AccountWithPerf[]>([])
  const [perfData, setPerfData] = useState<PerformancePoint[]>([])
  const [view, setView] = useState<'institution' | 'type'>('institution')
  const [timeRange, setTimeRange] = useState<'1Y' | '3Y' | '5Y' | 'ALL'>('3Y')

  useEffect(() => {
    Promise.all([fetchAccounts(), fetchGrants()]).then(([accts, grants]) => {
      const _vestedValue = grants.total_vested_value
      const withPerf: AccountWithPerf[] = accts
        .filter((a) => a.latest_balance != null
          && !['checking', 'credit_card'].includes(a.account_type))
        .map((a) => ({
          ...a,
          // For stock options, show after-tax vested value as balance, keep notional
          latest_balance: a.account_type === 'stock_options'
            ? grants.total_after_tax_vested_value
            : a.latest_balance,
          notional_value: a.account_type === 'stock_options'
            ? grants.total_vested_value
            : undefined,
          returnPct:
            a.total_earned != null && a.total_invested != null && a.total_invested > 0
              ? (a.total_earned / a.total_invested) * 100
              : null,
        }))
      setAccounts(withPerf)
    })
    fetchPerformance().then(setPerfData)
  }, [])

  const startDate = getStartDate(timeRange)

  // Compute period-specific returns per account
  const periodReturns = useMemo(() => {
    const byAcct: Record<string, PerformancePoint[]> = {}
    for (const p of perfData) {
      if (!byAcct[p.account_id]) byAcct[p.account_id] = []
      byAcct[p.account_id].push(p)
    }
    const result: Record<string, { earned: number; invested: number; returnPct: number }> = {}
    for (const [id, points] of Object.entries(byAcct)) {
      const pr = periodReturn(points, startDate)
      if (pr) result[id] = pr
    }
    return result
  }, [perfData, startDate])

  const totalBalance = accounts.reduce((s, a) => s + (a.latest_balance ?? 0), 0)
  const totalEarned = Object.values(periodReturns).reduce((s, r) => s + r.earned, 0)
  const totalInvested = Object.values(periodReturns).reduce((s, r) => s + r.invested, 0)

  // Group accounts by the selected dimension
  const groups: Record<string, AccountWithPerf[]> = {}
  for (const a of accounts) {
    const key = view === 'institution' ? (a.institution ?? 'other') : a.account_type
    if (!groups[key]) groups[key] = []
    groups[key].push(a)
  }

  // Sort groups by total balance descending
  const sortedGroups = Object.entries(groups).sort(
    ([, a], [, b]) =>
      b.reduce((s, x) => s + (x.latest_balance ?? 0), 0) -
      a.reduce((s, x) => s + (x.latest_balance ?? 0), 0),
  )

  return (
    <>
      <PerformanceVsBenchmark onTimeRangeChange={setTimeRange} />
      <AllocationChart />
      <AllocationOverTime />
      <GrantsDetail />

      <section className="chart-section">
        <div className="section-header">
          <div>
            <h2>Portfolio Composition <span style={{ fontWeight: 300, fontSize: '0.6em', color: 'rgba(255,255,255,0.35)' }}>({timeRange})</span></h2>
            {totalInvested > 0 && (
              <div className="metric-row">
                <span className="metric">
                  <span className="metric-label">Total Value</span>
                  <span className="metric-value">{fmtDollar(totalBalance)}</span>
                </span>
                <span className="metric">
                  <span className="metric-label">Invested</span>
                  <span className="metric-value">{fmtDollar(totalInvested)}</span>
                </span>
                <span className={`metric ${totalEarned >= 0 ? 'positive' : 'negative'}`}>
                  <span className="metric-label">Total Return</span>
                  <span className="metric-value">
                    {totalEarned >= 0 ? '+' : ''}
                    {fmtDollar(totalEarned)}
                    {totalInvested > 0 && ` (${fmtPct((totalEarned / totalInvested) * 100)})`}
                  </span>
                </span>
              </div>
            )}
          </div>
          <div className="controls">
            <div className="time-range-selector">
              <button
                className={`range-btn ${view === 'institution' ? 'active' : ''}`}
                onClick={() => setView('institution')}
              >
                By Institution
              </button>
              <button
                className={`range-btn ${view === 'type' ? 'active' : ''}`}
                onClick={() => setView('type')}
              >
                By Type
              </button>
            </div>
          </div>
        </div>

        {/* Allocation bar */}
        <div className="allocation-bar">
          {sortedGroups.map(([key, accts]) => {
            const groupTotal = accts.reduce((s, a) => s + (a.latest_balance ?? 0), 0)
            const pct = totalBalance > 0 ? (groupTotal / totalBalance) * 100 : 0
            if (pct < 0.5) return null
            const color =
              view === 'institution'
                ? INST_COLORS[key] ?? '#a78bfa'
                : `hsl(${Object.keys(groups).indexOf(key) * 47 + 220}, 70%, 65%)`
            return (
              <div
                key={key}
                className="allocation-segment"
                style={{ width: `${pct}%`, backgroundColor: color }}
                title={`${view === 'institution' ? key : TYPE_LABELS[key] ?? key}: ${fmtDollar(groupTotal)} (${pct.toFixed(1)}%)`}
              />
            )
          })}
        </div>

        {/* Group breakdown table */}
        <div className="portfolio-groups">
          {sortedGroups.map(([key, accts]) => {
            const groupTotal = accts.reduce((s, a) => s + (a.latest_balance ?? 0), 0)
            const groupEarned = accts.reduce((s, a) => s + (periodReturns[a.id]?.earned ?? 0), 0)
            const groupAvgInvested = accts.reduce((s, a) => {
              const pr = periodReturns[a.id]
              return s + (pr ? (pr.invested + (a.latest_balance ?? 0)) / 2 : 0)
            }, 0)
            const pct = totalBalance > 0 ? (groupTotal / totalBalance) * 100 : 0
            const color =
              view === 'institution'
                ? INST_COLORS[key] ?? '#a78bfa'
                : `hsl(${Object.keys(groups).indexOf(key) * 47 + 220}, 70%, 65%)`
            const label = view === 'institution' ? key : (TYPE_LABELS[key] ?? key)

            return (
              <div key={key} className="portfolio-group">
                <div className="portfolio-group-header" style={{ borderLeftColor: color }}>
                  <div className="portfolio-group-name">
                    <span className="inst-name">{label}</span>
                    <span className="portfolio-pct">{pct.toFixed(1)}%</span>
                  </div>
                  <div className="portfolio-group-totals">
                    {groupAvgInvested > 0 && (
                      <span className={`portfolio-return ${groupEarned >= 0 ? 'positive' : 'negative'}`}>
                        {groupEarned >= 0 ? '+' : ''}
                        {fmtDollar(groupEarned)}
                        {` (${fmtPct((groupEarned / groupAvgInvested) * 100)})`}
                      </span>
                    )}
                    <span className="inst-total">{fmtDollar(groupTotal)}</span>
                  </div>
                </div>
                <table className="portfolio-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      {view === 'type' && <th>Institution</th>}
                      {view === 'institution' && <th>Type</th>}
                      <th className="right">Balance</th>
                      <th className="right">Invested</th>
                      <th className="right">Return</th>
                      <th className="right">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accts
                      .sort((a, b) => (b.latest_balance ?? 0) - (a.latest_balance ?? 0))
                      .map((a) => {
                        const pr = periodReturns[a.id]
                        return (
                          <tr key={a.id}>
                            <td>{a.name}</td>
                            {view === 'type' && <td className="acct">{a.institution}</td>}
                            {view === 'institution' && (
                              <td className="acct">{TYPE_LABELS[a.account_type] ?? a.account_type}</td>
                            )}
                            <td className="amount right">
                              {fmtDollar(a.latest_balance ?? 0)}
                              {a.notional_value != null && (
                                <div style={{ fontSize: '0.8em', color: 'rgba(255,255,255,0.35)' }}>
                                  {fmtDollar(a.notional_value)} pre-tax
                                </div>
                              )}
                            </td>
                            <td className="amount right">
                              {pr ? fmtDollar(pr.invested) : '—'}
                            </td>
                            <td
                              className={`amount right ${pr ? (pr.earned >= 0 ? 'positive' : 'negative') : ''}`}
                            >
                              {pr
                                ? `${pr.earned >= 0 ? '+' : ''}${fmtDollar(pr.earned)}`
                                : '—'}
                            </td>
                            <td className="amount right">
                              {pr ? fmtPct(pr.returnPct) : '—'}
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      </section>
    </>
  )
}
