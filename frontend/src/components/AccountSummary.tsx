import type { Account } from '../api'

interface Props {
  accounts: Account[]
}

const fmtDollar = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const INST_COLORS: Record<string, string> = {
  betterment: '#818cf8',
  wealthfront: '#34d399',
  ally: '#fb923c',
}

export function AccountSummary({ accounts }: Props) {
  // Group by institution
  const byInst: Record<string, Account[]> = {}
  for (const a of accounts) {
    const inst = a.institution ?? 'other'
    if (!byInst[inst]) byInst[inst] = []
    byInst[inst].push(a)
  }

  return (
    <section className="chart-section">
      <h2>Accounts</h2>
      <div className="account-groups">
        {Object.entries(byInst).map(([inst, accts]) => {
          const total = accts.reduce((s, a) => s + (a.latest_balance ?? 0), 0)
          const color = INST_COLORS[inst] ?? '#a78bfa'
          return (
            <div key={inst} className="account-group">
              <div className="group-header" style={{ borderLeftColor: color }}>
                <span className="inst-name">{inst}</span>
                <span className="inst-total">{fmtDollar(total)}</span>
              </div>
              {accts.map((a) => {
                const gain = a.total_earned
                const gainPct =
                  gain != null && a.total_invested && a.total_invested > 0
                    ? (gain / a.total_invested) * 100
                    : null
                return (
                  <div key={a.id} className="account-card">
                    <div className="account-top">
                      <span className="account-name">{a.name}</span>
                      <span className="account-type">{a.account_type}</span>
                    </div>
                    <div className="account-balance">
                      {a.latest_balance != null ? fmtDollar(a.latest_balance) : '—'}
                    </div>
                    {gain != null && (
                      <div className={`account-gain ${gain >= 0 ? 'positive' : 'negative'}`}>
                        {gain >= 0 ? '+' : ''}
                        {fmtDollar(gain)}
                        {gainPct != null && (
                          <span className="gain-pct">
                            {' '}({gainPct >= 0 ? '+' : ''}{gainPct.toFixed(1)}%)
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </section>
  )
}
