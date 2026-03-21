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

const INST_COLORS: Record<string, string> = {
  betterment: '#818cf8',
  wealthfront: '#34d399',
  ally: '#fb923c',
  chase: '#22d3ee',
  capital_one: '#38bdf8',
  morgan_stanley: '#f472b6',
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
        const color = INST_COLORS[inst] ?? '#a78bfa'
        return (
          <div key={inst} className="sidebar-group">
            <div className="sidebar-group-header">
              <span className="sidebar-dot" style={{ backgroundColor: color }} />
              <span className="sidebar-inst">{inst}</span>
              <span className="sidebar-total">{fmtDollar(total)}</span>
            </div>
            {accts
              .filter((a) => a.latest_balance != null)
              .sort((a, b) => Math.abs(b.latest_balance ?? 0) - Math.abs(a.latest_balance ?? 0))
              .map((a) => (
                <div key={a.id} className="sidebar-account">
                  <span className="sidebar-account-name">{a.name}</span>
                  <span className="sidebar-account-bal">{fmtDollar(a.latest_balance ?? 0)}</span>
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}
