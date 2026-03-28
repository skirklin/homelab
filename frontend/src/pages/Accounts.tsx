import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Account, SyncHistoryEntry, SyncStatus } from '../api'
import { fetchAccounts, fetchSyncHistory, fetchSyncStatus, createManualAccount } from '../api'

const fmtDollar = (v: number) => {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`
  return `${sign}$${abs.toFixed(2)}`
}

function timeAgo(secondsAgo: number | null): string {
  if (secondsAgo == null) return 'never'
  if (secondsAgo < 60) return 'just now'
  const minutes = Math.floor(secondsAgo / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

type SortKey = 'person' | 'institution' | 'synced' | 'account' | 'type' | 'balance'
type SortDir = 'asc' | 'desc'

interface AccountRow {
  accountId: string
  loginId: string
  person: string
  personId: string
  institution: string
  institutionId: string
  label: string
  url: string | null
  isStale: boolean
  secondsAgo: number | null
  accountName: string
  accountType: string
  balance: number | null
}

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [statuses, setStatuses] = useState<SyncStatus[]>([])
  const [syncHistory, setSyncHistory] = useState<SyncHistoryEntry[]>([])
  const [sortKey, setSortKey] = useState<SortKey>('institution')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newValue, setNewValue] = useState('')
  const [addingAccount, setAddingAccount] = useState(false)

  useEffect(() => {
    fetchAccounts().then(setAccounts)
    fetchSyncStatus().then(setStatuses)
    fetchSyncHistory(20).then(setSyncHistory)
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

  // Build flat rows — use sync_history timestamp for freshness
  const statusMap = new Map(statuses.map((s) => [s.login_id, s]))

  const rows: AccountRow[] = accounts
    .map((a) => {
      const s = a.profile ? statusMap.get(a.profile) : undefined
      const secondsAgo = s?.seconds_ago ?? null
      return {
        accountId: a.id,
        loginId: a.profile || '',
        person: s?.person_name || a.profile?.split('@')[0] || '',
        personId: s?.person || a.profile?.split('@')[0] || '',
        institution: s?.label?.split(' (')[0] || a.institution || 'Manual',
        institutionId: s?.institution || a.institution || '',
        label: s?.label || a.institution || 'Manual',
        url: s?.url || null,
        isStale: s?.is_stale || false,
        secondsAgo,
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
      case 'synced': return dir * ((a.secondsAgo ?? Infinity) - (b.secondsAgo ?? Infinity))
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            style={{
              fontSize: 11,
              padding: '3px 10px',
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.15)',
              background: showAddForm ? 'rgba(129,140,248,0.2)' : 'rgba(255,255,255,0.05)',
              color: 'rgba(255,255,255,0.6)',
              cursor: 'pointer',
            }}
          >
            + Add Asset
          </button>
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
      </div>

      {showAddForm && (
        <div className="card" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
              Name
            </label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. House"
              style={{
                width: 160,
                padding: '4px 8px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4,
                color: 'inherit',
                fontSize: 13,
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
              Current Value
            </label>
            <input
              type="number"
              step="0.01"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="0.00"
              style={{
                width: 120,
                padding: '4px 8px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4,
                color: 'inherit',
                fontSize: 13,
              }}
            />
          </div>
          <button
            onClick={async () => {
              if (!newName.trim()) return
              setAddingAccount(true)
              try {
                await createManualAccount(newName.trim(), 'other', parseFloat(newValue) || 0)
                setShowAddForm(false)
                setNewName('')
                setNewValue('')
                fetchAccounts().then(setAccounts)
              } finally {
                setAddingAccount(false)
              }
            }}
            disabled={addingAccount || !newName.trim()}
            style={{
              padding: '5px 16px',
              borderRadius: 4,
              border: 'none',
              background: '#818cf8',
              color: '#fff',
              fontSize: 12,
              cursor: addingAccount ? 'wait' : 'pointer',
              opacity: addingAccount || !newName.trim() ? 0.5 : 1,
            }}
          >
            {addingAccount ? 'Creating...' : 'Create'}
          </button>
          <button
            onClick={() => setShowAddForm(false)}
            style={{
              padding: '5px 12px',
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.5)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}

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
              <td>
                {r.personId ? (
                  <Link
                    to={`/people/${r.personId}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                    onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                    onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                  >
                    {r.person}
                  </Link>
                ) : r.person}
              </td>
              <td>
                <span className="accounts-dot" style={{
                  backgroundColor: r.isStale ? '#f87171' : '#34d399',
                }} />
                {r.institutionId ? (
                  <Link
                    to={`/institutions/${r.institutionId}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                    onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                    onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                  >
                    {r.institution}
                  </Link>
                ) : r.institution}
                {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="accounts-open">↗</a>}
              </td>
              <td className="dim">{timeAgo(r.secondsAgo)}</td>
              <td>
                <Link
                  to={`/accounts/${r.accountId}`}
                  style={{ color: 'inherit', textDecoration: 'none' }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                >
                  {r.accountName}
                </Link>
              </td>
              <td className="dim">{r.accountType}</td>
              <td className="amount right">{r.balance != null ? fmtDollar(r.balance) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: '2rem' }}>Sync History</h3>
      <table className="accounts-table" style={{ fontSize: '0.85rem' }}>
        <thead>
          <tr>
            <th>Time</th>
            <th>Institution</th>
            <th>Profile</th>
            <th>Status</th>
            <th>Accounts</th>
            <th>Transactions</th>
            <th>Balances</th>
            <th>Holdings</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {syncHistory.map((s) => {
            const duration = s.started_at && s.finished_at
              ? `${((new Date(s.finished_at).getTime() - new Date(s.started_at).getTime()) / 1000).toFixed(1)}s`
              : '—'
            return (
              <tr key={s.id} style={s.status === 'error' ? { color: '#f87171' } : undefined}>
                <td className="dim">{s.started_at ? timeAgo(Math.floor((Date.now() - new Date(s.started_at).getTime()) / 1000)) : 'never'}</td>
                <td>{s.institution}</td>
                <td className="dim">{s.profile?.split('@')[0] || '—'}</td>
                <td>
                  {s.status === 'complete' ? '✓' : s.status === 'error' ? '✗' : '⟳'}
                  {s.status === 'error' && s.error_message && (
                    <span title={s.error_message} style={{ cursor: 'help', marginLeft: 4 }}>
                      {s.error_message.slice(0, 30)}
                    </span>
                  )}
                </td>
                <td className="right">{s.accounts ?? '—'}</td>
                <td className="right">{s.transactions ?? '—'}</td>
                <td className="right">{s.balances ?? '—'}</td>
                <td className="right">{s.holdings ?? '—'}</td>
                <td className="right dim">{duration}</td>
              </tr>
            )
          })}
          {syncHistory.length === 0 && (
            <tr><td colSpan={9} className="dim" style={{ textAlign: 'center' }}>No sync history yet</td></tr>
          )}
        </tbody>
      </table>
    </section>
  )
}
