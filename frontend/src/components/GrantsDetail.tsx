import { useEffect, useState } from 'react'
import type { GrantsSummary } from '../api'
import { fetchGrants } from '../api'

const fmtDollar = (v: number) => {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`
  return `${sign}$${abs.toFixed(2)}`
}

const fmtShares = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })

export function GrantsDetail() {
  const [data, setData] = useState<GrantsSummary | null>(null)

  useEffect(() => {
    fetchGrants().then(setData)
  }, [])

  if (!data || data.grants.length === 0) return null

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>Equity Grants</h2>
          <div className="metric-row">
            <span className="metric positive">
              <span className="metric-label">Vested</span>
              <span className="metric-value">{fmtDollar(data.total_vested_value)}</span>
            </span>
            <span className="metric" style={{ opacity: 0.5 }}>
              <span className="metric-label">Unvested</span>
              <span className="metric-value">{fmtDollar(data.total_unvested_value)}</span>
            </span>
            <span className="metric">
              <span className="metric-label">409A FMV</span>
              <span className="metric-value">${data.fmv_per_share.toFixed(2)}</span>
            </span>
          </div>
        </div>
      </div>
      <table className="portfolio-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>Type</th>
            <th>Grant Date</th>
            <th className="right">Total</th>
            <th className="right">Vested</th>
            <th className="right">Unvested</th>
            <th className="right">Strike</th>
            <th className="right">Vested Value</th>
            <th>Vesting</th>
          </tr>
        </thead>
        <tbody>
          {data.grants.map((g) => (
            <tr key={g.id}>
              <td>
                <span style={{
                  padding: '1px 6px',
                  borderRadius: 3,
                  fontSize: 11,
                  fontWeight: 600,
                  background: g.type === 'RSU' ? 'rgba(52,211,153,0.15)' :
                    g.type === 'ISO' ? 'rgba(129,140,248,0.15)' : 'rgba(251,191,36,0.15)',
                  color: g.type === 'RSU' ? '#34d399' :
                    g.type === 'ISO' ? '#818cf8' : '#fbbf24',
                }}>
                  {g.type}
                </span>
              </td>
              <td style={{ fontSize: 12 }}>{g.grant_date}</td>
              <td className="amount right">{fmtShares(g.total_shares)}</td>
              <td className="amount right positive">{fmtShares(g.vested_shares)}</td>
              <td className="amount right" style={{ opacity: 0.4 }}>
                {fmtShares(g.unvested_shares)}
              </td>
              <td className="amount right">
                {g.strike_price > 0 ? `$${g.strike_price.toFixed(2)}` : '—'}
              </td>
              <td className="amount right positive">{fmtDollar(g.vested_value)}</td>
              <td style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                {g.vesting_schedule} / {g.vesting_months}mo
                {g.pct_vested >= 100 ? (
                  <span style={{ color: '#34d399', marginLeft: 6 }}>fully vested</span>
                ) : (
                  <span style={{ marginLeft: 6 }}>{g.pct_vested}%</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
