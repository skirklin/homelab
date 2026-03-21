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

type SortKey = 'person' | 'institution' | 'synced' | 'account' | 'type' | 'balance'
type SortDir = 'asc' | 'desc'

interface AccountRow {
  loginId: string
  person: string
  institution: string
  label: string
  url: string | null
  isStale: boolean
  freshest: string | null
  accountName: string
  accountType: string
  balance: number | null
}

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [statuses, setStatuses] = useState<SyncStatus[]>([])
  const [sortKey, setSortKey] = useState<SortKey>('institution')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  useEffect(() => {
    fetchAccounts().then(setAccounts)
    fetchSyncStatus().then(setStatuses)
  }, [])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir(key === 'balance' ? 'desc' : 'asc')
    }
  }

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  // Build flat rows
  const statusMap = new Map(statuses.map((s) => [s.login_id, s]))

  const rows: AccountRow[] = accounts
    .filter((a) => a.institution)
    .map((a) => {
      // Match by profile first, fall back to first login for the institution
      let s = a.profile ? statusMap.get(a.profile) : undefined
      if (!s) {
        s = statuses.find((st) => st.institution === a.institution)
      }
      const freshest = s?.last_balance_date || s?.last_transaction_date || null
      return {
        loginId: a.profile || '',
        person: s?.person_name || '',
        institution: s?.label?.split(' (')[0] || a.institution || '',
        label: s?.label || a.institution || '',
        url: s?.url || null,
        isStale: s?.is_stale ?? false,
        freshest,
        accountName: a.name,
        accountType: a.account_type,
        balance: a.latest_balance,
      }
    })

  // Sort
  const sorted = [...rows].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1
    switch (sortKey) {
      case 'person': return dir * a.person.localeCompare(b.person)
      case 'institution': return dir * a.institution.localeCompare(b.institution)
      case 'synced': return dir * ((a.freshest || '') < (b.freshest || '') ? -1 : 1)
      case 'account': return dir * a.accountName.localeCompare(b.accountName)
      case 'type': return dir * a.accountType.localeCompare(b.accountType)
      case 'balance': return dir * ((a.balance ?? 0) - (b.balance ?? 0))
      default: return 0
    }
  })

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
            <th onClick={() => handleSort('person')} style={{ cursor: 'pointer' }}>
              Person{sortIndicator('person')}
            </th>
            <th onClick={() => handleSort('institution')} style={{ cursor: 'pointer' }}>
              Institution{sortIndicator('institution')}
            </th>
            <th onClick={() => handleSort('synced')} style={{ cursor: 'pointer' }}>
              Synced{sortIndicator('synced')}
            </th>
            <th onClick={() => handleSort('account')} style={{ cursor: 'pointer' }}>
              Account{sortIndicator('account')}
            </th>
            <th onClick={() => handleSort('type')} style={{ cursor: 'pointer' }}>
              Type{sortIndicator('type')}
            </th>
            <th onClick={() => handleSort('balance')} className="right" style={{ cursor: 'pointer' }}>
              Balance{sortIndicator('balance')}
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={`${r.loginId}-${r.accountName}-${i}`}>
              <td>{r.person}</td>
              <td>
                <span className="accounts-dot" style={{
                  backgroundColor: r.isStale ? '#f87171' : '#34d399',
                }} />
                {r.institution}
                {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="accounts-open">↗</a>}
              </td>
              <td className="dim">{r.freshest ? timeAgo(r.freshest) : 'never'}</td>
              <td>{r.accountName}</td>
              <td className="dim">{r.accountType}</td>
              <td className="amount right">{r.balance != null ? fmtDollar(r.balance) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
