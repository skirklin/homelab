import { Link } from 'react-router-dom'
import type { Account } from '../api'

interface Props {
  accounts: Account[]
}

const fmtDollar = (v: number) => {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`
  return `${sign}$${abs.toFixed(2)}`
}

function isStale(a: Account): boolean {
  if (!a.balance_as_of) return true
  const days = Math.floor(
    (Date.now() - new Date(a.balance_as_of + 'T00:00:00').getTime()) / 86400000,
  )
  return days > 3
}

export function AccountSummary({ accounts }: Props) {
  const byInst: Record<string, Account[]> = {}
  for (const a of accounts) {
    const inst = a.institution ?? 'other'
    if (!byInst[inst]) byInst[inst] = []
    byInst[inst].push(a)
  }

  const sorted = Object.entries(byInst).sort(
    ([, a], [, b]) =>
      Math.abs(b.reduce((s, x) => s + (x.latest_balance ?? 0), 0)) -
      Math.abs(a.reduce((s, x) => s + (x.latest_balance ?? 0), 0)),
  )

  return (
    <div className="account-sidebar">
      {sorted.map(([inst, accts]) => {
        const total = accts.reduce((s, a) => s + (a.latest_balance ?? 0), 0)
        const anyStale = accts.some(isStale)
        return (
          <div key={inst} className="sidebar-group">
            <div className="sidebar-group-header">
              <Link to={inst === 'other' ? '/accounts' : `/institutions/${inst}`}
                className="sidebar-inst" style={{ color: 'inherit', textDecoration: 'none' }}>{inst}</Link>
              <span className="sidebar-total">{fmtDollar(total)}</span>
            </div>
            {accts
              .filter((a) => a.latest_balance != null)
              .sort((a, b) => Math.abs(b.latest_balance ?? 0) - Math.abs(a.latest_balance ?? 0))
              .map((a) => (
                <Link key={a.id} to={`/accounts/${a.id}`} className="sidebar-account"
                  style={{ color: 'inherit', textDecoration: 'none' }}>
                  <span
                    className="sidebar-dot"
                    style={{ backgroundColor: isStale(a) ? '#f87171' : '#34d399' }}
                  />
                  <span className="sidebar-account-name">{a.name}</span>
                  <span className="sidebar-account-bal">{fmtDollar(a.latest_balance ?? 0)}</span>
                </Link>
              ))}
          </div>
        )
      })}
    </div>
  )
}
