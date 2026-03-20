import { useEffect, useState } from 'react'
import type { Account } from '../api'
import { fetchAccounts } from '../api'
import { AllocationChart } from '../components/AllocationChart'
import { PerformanceVsBenchmark } from '../components/PerformanceVsBenchmark'

const fmtDollar = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

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
}

export function Investments() {
  const [accounts, setAccounts] = useState<AccountWithPerf[]>([])
  const [view, setView] = useState<'institution' | 'type'>('institution')

  useEffect(() => {
    fetchAccounts().then((accts) => {
      const withPerf: AccountWithPerf[] = accts
        .filter((a) => a.latest_balance != null)
        .map((a) => ({
          ...a,
          returnPct:
            a.total_earned != null && a.total_invested != null && a.total_invested > 0
              ? (a.total_earned / a.total_invested) * 100
              : null,
        }))
      setAccounts(withPerf)
    })
  }, [])

  const totalBalance = accounts.reduce((s, a) => s + (a.latest_balance ?? 0), 0)
  const totalInvested = accounts.reduce((s, a) => s + (a.total_invested ?? 0), 0)
  const totalEarned = accounts.reduce((s, a) => s + (a.total_earned ?? 0), 0)

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
      <PerformanceVsBenchmark />
      <AllocationChart />

      <section className="chart-section">
        <div className="section-header">
          <div>
            <h2>Portfolio Composition</h2>
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
            const groupInvested = accts.reduce((s, a) => s + (a.total_invested ?? 0), 0)
            const groupEarned = accts.reduce((s, a) => s + (a.total_earned ?? 0), 0)
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
                    {groupInvested > 0 && (
                      <span className={`portfolio-return ${groupEarned >= 0 ? 'positive' : 'negative'}`}>
                        {groupEarned >= 0 ? '+' : ''}
                        {fmtDollar(groupEarned)}
                        {groupInvested > 0 && ` (${fmtPct((groupEarned / groupInvested) * 100)})`}
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
                      .map((a) => (
                        <tr key={a.id}>
                          <td>{a.name}</td>
                          {view === 'type' && <td className="acct">{a.institution}</td>}
                          {view === 'institution' && (
                            <td className="acct">{TYPE_LABELS[a.account_type] ?? a.account_type}</td>
                          )}
                          <td className="amount right">{fmtDollar(a.latest_balance ?? 0)}</td>
                          <td className="amount right">
                            {a.total_invested != null ? fmtDollar(a.total_invested) : '—'}
                          </td>
                          <td
                            className={`amount right ${a.total_earned != null ? (a.total_earned >= 0 ? 'positive' : 'negative') : ''}`}
                          >
                            {a.total_earned != null
                              ? `${a.total_earned >= 0 ? '+' : ''}${fmtDollar(a.total_earned)}`
                              : '—'}
                          </td>
                          <td className="amount right">
                            {a.returnPct != null ? fmtPct(a.returnPct) : '—'}
                          </td>
                        </tr>
                      ))}
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
