import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import Plot from 'react-plotly.js'
import type { InstitutionDetail as InstitutionDetailData } from '../api'
import { fetchInstitutionDetail } from '../api'

const fmtDollar = (v: number) => {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`
  return `${sign}$${abs.toFixed(2)}`
}

export default function InstitutionDetail() {
  const { institution } = useParams<{ institution: string }>()
  const [data, setData] = useState<InstitutionDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!institution) return
    fetchInstitutionDetail(institution)
      .then((d) => {
        setData(d)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [institution])

  if (loading) return <div className="loading">Loading...</div>
  if (error) return <div className="error">Error: {error}</div>
  if (!data) return <div className="error">Institution not found</div>

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <Link to="/accounts" style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, textDecoration: 'none' }}>
            &larr; All Accounts
          </Link>
          <h2 style={{ margin: '4px 0 0' }}>
            {data.label}
            {data.url && (
              <a
                href={data.url}
                target="_blank"
                rel="noreferrer"
                style={{ marginLeft: 8, fontSize: 13, color: 'rgba(255,255,255,0.4)', textDecoration: 'none' }}
              >
                ↗
              </a>
            )}
          </h2>
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 2 }}>
            {data.accounts.length} account{data.accounts.length !== 1 ? 's' : ''}
            <span style={{ marginLeft: 12, color: 'rgba(255,255,255,0.8)', fontWeight: 600 }}>
              {fmtDollar(data.total_balance)}
            </span>
          </div>
        </div>
      </div>

      {data.balance_history_by_account.length > 0 && (
        <div className="card" style={{ padding: '12px 0', marginBottom: 16 }}>
          <Plot
            data={data.balance_history_by_account.map((series, i) => {
              const colors = ['#818cf8', '#34d399', '#f59e0b', '#f87171', '#a78bfa', '#22d3ee', '#fb923c', '#e879f9']
              const color = colors[i % colors.length]
              return {
                x: series.points.map((p) => p.date),
                y: series.points.map((p) => p.balance),
                type: 'scatter' as const,
                mode: 'lines' as const,
                name: series.account_name,
                stackgroup: 'one',
                line: { color, width: 1 },
                fillcolor: color.replace(')', ', 0.15)').replace('rgb', 'rgba').replace('#', ''),
                hovertemplate: `${series.account_name}: $%{y:,.0f}<extra></extra>`,
              }
            })}
            layout={{
              paper_bgcolor: 'transparent',
              plot_bgcolor: 'transparent',
              font: { color: 'rgba(255,255,255,0.6)', size: 11 },
              margin: { l: 60, r: 20, t: 10, b: 40 },
              showlegend: data.balance_history_by_account.length > 1,
              legend: { font: { size: 10 }, orientation: 'h', y: -0.15 },
              xaxis: {
                gridcolor: 'rgba(255,255,255,0.06)',
                linecolor: 'rgba(255,255,255,0.06)',
              },
              yaxis: {
                gridcolor: 'rgba(255,255,255,0.06)',
                linecolor: 'rgba(255,255,255,0.06)',
                tickprefix: '$',
                zeroline: true,
                zerolinecolor: 'rgba(255,255,255,0.1)',
              },
              hoverlabel: {
                bgcolor: '#1e1e3f',
                bordercolor: 'rgba(255,255,255,0.1)',
                font: { color: 'rgba(255,255,255,0.8)', size: 12 },
              },
              hovermode: 'x unified',
            }}
            config={{ responsive: true, displayModeBar: false }}
            useResizeHandler
            style={{ width: '100%', height: 350 }}
          />
        </div>
      )}

      {data.by_person.length > 0 && (
        <>
          <h3 style={{ marginTop: '1.5rem', marginBottom: '0.5rem' }}>By Person</h3>
          <table className="accounts-table">
            <thead>
              <tr>
                <th>Person</th>
                <th className="right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.by_person
                .sort((a, b) => b.balance - a.balance)
                .map((p) => (
                  <tr key={p.person}>
                    <td>
                      <Link
                        to={`/people/${p.person}`}
                        style={{ color: 'inherit', textDecoration: 'none' }}
                        onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                        onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                      >
                        {p.name}
                      </Link>
                    </td>
                    <td className="amount right">{fmtDollar(p.balance)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}

      <h3 style={{ marginTop: '1.5rem', marginBottom: '0.5rem' }}>Accounts</h3>
      <table className="accounts-table">
        <thead>
          <tr>
            <th>Person</th>
            <th>Account</th>
            <th>Type</th>
            <th className="right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {data.accounts.map((a) => (
            <tr key={a.id}>
              <td className="dim">{a.profile?.split('@')[0] || '—'}</td>
              <td>
                <Link
                  to={`/accounts/${a.id}`}
                  style={{ color: 'inherit', textDecoration: 'none' }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                >
                  {a.name}
                </Link>
              </td>
              <td className="dim">{a.account_type}</td>
              <td className="amount right">{a.latest_balance != null ? fmtDollar(a.latest_balance) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.accounts.length === 0 && data.balance_history_by_account.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'rgba(255,255,255,0.4)' }}>
          No data yet for this institution.
        </div>
      )}
    </section>
  )
}
