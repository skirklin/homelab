import { useEffect, useState } from 'react'
import type { Account, SyncStatus } from '../api'
import { fetchAccounts, fetchSyncStatus } from '../api'

const fmtDollar = (v: number) => {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`
  return `${sign}$${abs.toFixed(2)}`
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'))
  const now = new Date()
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [statuses, setStatuses] = useState<SyncStatus[]>([])

  useEffect(() => {
    fetchAccounts().then(setAccounts)
    fetchSyncStatus().then(setStatuses)
  }, [])

  const uniqueUrls = [...new Set(statuses.filter((s) => s.url).map((s) => s.url as string))]

  return (
    <section className="chart-section">
      <div className="section-header">
        <h2>Accounts</h2>
        {uniqueUrls.length > 0 && (
          <button
            onClick={() => uniqueUrls.forEach((url) => window.open(url, '_blank'))}
            style={{
              fontSize: 11,
              padding: '3px 10px',
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'rgba(255,255,255,0.05)',
              color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
            }}
          >
            Refresh All
          </button>
        )}
      </div>

      <table className="accounts-table">
        <thead>
          <tr>
            <th>Login</th>
            <th>Synced</th>
            <th>Account</th>
            <th>Type</th>
            <th className="right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {statuses.map((s) => {
            const loginAccounts = accounts.filter(
              (a) => a.profile === s.login_id ||
                (!a.profile && a.institution === s.institution),
            )
            const freshest = s.last_balance_date || s.last_transaction_date

            if (loginAccounts.length === 0) {
              return (
                <tr key={s.login_id} className="accounts-login-row">
                  <td>
                    <span className="accounts-dot" style={{
                      backgroundColor: s.is_stale ? '#f87171' : '#34d399',
                    }} />
                    {s.label}
                    {s.url && <a href={s.url} target="_blank" rel="noreferrer" className="accounts-open">↗</a>}
                  </td>
                  <td className="dim">{freshest ? timeAgo(freshest) : 'never'}</td>
                  <td className="dim" colSpan={3}>no accounts</td>
                </tr>
              )
            }

            return loginAccounts
              .sort((a, b) => Math.abs(b.latest_balance ?? 0) - Math.abs(a.latest_balance ?? 0))
              .map((a, i) => (
                <tr key={a.id} className={i === 0 ? 'accounts-login-row' : ''}>
                  {i === 0 ? (
                    <>
                      <td rowSpan={loginAccounts.length}>
                        <span className="accounts-dot" style={{
                          backgroundColor: s.is_stale ? '#f87171' : '#34d399',
                        }} />
                        {s.label}
                        {s.url && <a href={s.url} target="_blank" rel="noreferrer" className="accounts-open">↗</a>}
                      </td>
                      <td rowSpan={loginAccounts.length} className="dim">
                        {freshest ? timeAgo(freshest) : 'never'}
                      </td>
                    </>
                  ) : null}
                  <td>{a.name}</td>
                  <td className="dim">{a.account_type}</td>
                  <td className="amount right">
                    {a.latest_balance != null ? fmtDollar(a.latest_balance) : '—'}
                  </td>
                </tr>
              ))
          })}
        </tbody>
      </table>
    </section>
  )
}
