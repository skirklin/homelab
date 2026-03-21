import { useEffect, useState } from 'react'
import type { SyncStatus } from '../api'
import { fetchSyncStatus } from '../api'

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

/** Compact indicator — just dots for stale logins, shown on Overview */
export function SyncStatusCompact() {
  const [statuses, setStatuses] = useState<SyncStatus[]>([])

  useEffect(() => {
    fetchSyncStatus().then(setStatuses)
  }, [])

  const stale = statuses.filter((s) => s.is_stale)
  if (stale.length === 0 && statuses.length > 0) return null // all fresh, show nothing

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 11,
      color: 'rgba(255,255,255,0.4)',
    }}>
      {stale.length > 0 ? (
        <>
          <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#f87171' }} />
          {stale.length} stale
        </>
      ) : (
        <span style={{ color: 'rgba(255,255,255,0.2)' }}>loading...</span>
      )}
    </div>
  )
}

/** Full status bar with Refresh All button */
export function SyncStatusBar() {
  const [statuses, setStatuses] = useState<SyncStatus[]>([])

  useEffect(() => {
    fetchSyncStatus().then(setStatuses)
  }, [])

  if (statuses.length === 0) return null

  const refreshableUrls = statuses
    .filter((s) => s.url)
    .map((s) => s.url as string)

  return (
    <section className="chart-section" style={{ padding: '12px 16px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 24px', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', fontWeight: 600 }}>
          Data Freshness
        </span>
        {refreshableUrls.length > 0 && (
          <button
            onClick={() => refreshableUrls.forEach((url) => window.open(url, '_blank'))}
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
        {statuses.map((s) => {
          const freshest = s.last_balance_date || s.last_transaction_date
          return (
            <span
              key={s.login_id}
              style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: s.is_stale ? '#f87171' : '#34d399',
                }}
              />
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>{s.label}</span>
              <span style={{ color: 'rgba(255,255,255,0.3)' }}>
                {freshest ? timeAgo(freshest) : 'never'}
              </span>
            </span>
          )
        })}
      </div>
    </section>
  )
}
