import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import Plot from 'react-plotly.js'
import type { Account, BalancePoint, PerformancePoint, Transaction, Holding } from '../api'
import { fetchAccounts, fetchBalances, fetchPerformance, fetchTransactions, fetchHoldings, updateManualBalance, renameAccount, deleteAccount } from '../api'
import { TimeRangeSelector, type TimeRange, getStartDate } from '../components/TimeRangeSelector'

const fmtDollar = (v: number) => {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`
  return `${sign}$${abs.toFixed(2)}`
}

export default function AccountDetail() {
  const { id } = useParams<{ id: string }>()
  const [account, setAccount] = useState<Account | null>(null)
  const [balances, setBalances] = useState<BalancePoint[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [perfHistory, setPerfHistory] = useState<PerformancePoint[]>([])
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Manual balance update form
  const [showUpdateForm, setShowUpdateForm] = useState(false)
  const [updateValue, setUpdateValue] = useState('')
  const [updateDate, setUpdateDate] = useState('')
  const [updating, setUpdating] = useState(false)

  // Time range
  const [range, setRange] = useState<TimeRange>('1Y')

  // Rename
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')

  useEffect(() => {
    if (!id) return

    Promise.all([
      fetchAccounts(),
      fetchBalances(id),
      fetchPerformance({ accountId: id }),
      fetchTransactions({ accountId: id, limit: 500 }),
      fetchHoldings(id),
    ])
      .then(([accounts, bals, perf, txns, holds]) => {
        const acct = accounts.find((a) => a.id === id) ?? null
        setAccount(acct)
        setBalances(bals)
        setPerfHistory(perf)
        setTransactions(txns)
        setHoldings(holds)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [id])

  const handleUpdateBalance = async () => {
    if (!id || !updateValue) return
    setUpdating(true)
    try {
      await updateManualBalance(id, parseFloat(updateValue), updateDate || undefined)
      // Refresh data
      const [accounts, bals] = await Promise.all([fetchAccounts(), fetchBalances(id)])
      setAccount(accounts.find((a) => a.id === id) ?? null)
      setBalances(bals)
      setShowUpdateForm(false)
      setUpdateValue('')
      setUpdateDate('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update balance')
    } finally {
      setUpdating(false)
    }
  }

  if (loading) return <div className="loading">Loading...</div>
  if (error) return <div className="error">Error: {error}</div>
  if (!account) return <div className="error">Account not found</div>

  const isManual = !account.institution

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <Link to="/accounts" style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, textDecoration: 'none' }}>
            &larr; All Accounts
          </Link>
          <h2 style={{ margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 8 }}>
            {editing ? (
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && editName.trim()) {
                    await renameAccount(account.id, editName.trim())
                    setEditing(false)
                    fetchAccounts().then(accts => {
                      const updated = accts.find(a => a.id === id)
                      if (updated) setAccount(updated)
                    })
                  } else if (e.key === 'Escape') {
                    setEditing(false)
                  }
                }}
                onBlur={() => setEditing(false)}
                style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.3)', color: 'inherit', fontSize: 'inherit', fontWeight: 'inherit', padding: '0 4px', width: 300 }}
              />
            ) : (
              <>
                {account.name}
                <span
                  onClick={() => { setEditing(true); setEditName(account.name) }}
                  style={{ cursor: 'pointer', fontSize: 14, color: 'rgba(255,255,255,0.25)' }}
                  title="Rename"
                >&#9998;</span>
              </>
            )}
          </h2>
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 2 }}>
            {isManual ? 'Manual' : account.institution} &middot; {account.account_type}
            {account.latest_balance != null && (
              <span style={{ marginLeft: 12, color: 'rgba(255,255,255,0.8)', fontWeight: 600 }}>
                {fmtDollar(account.latest_balance)}
              </span>
            )}
            {account.balance_as_of && (
              <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>
                as of {account.balance_as_of}
              </span>
            )}
          </div>
        </div>
        {isManual && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setShowUpdateForm(!showUpdateForm)}
              style={{
                fontSize: 12,
                padding: '4px 12px',
                borderRadius: 4,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.05)',
                color: 'rgba(255,255,255,0.7)',
                cursor: 'pointer',
              }}
            >
              Update Value
            </button>
            <button
              onClick={async () => {
                if (!confirm(`Delete "${account.name}"? This cannot be undone.`)) return
                await deleteAccount(account.id)
                window.location.href = '/accounts'
              }}
              style={{
                fontSize: 12,
                padding: '4px 12px',
                borderRadius: 4,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.05)',
                color: '#f87171',
                cursor: 'pointer',
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {showUpdateForm && (
        <div className="card" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
              Value
            </label>
            <input
              type="number"
              step="0.01"
              value={updateValue}
              onChange={(e) => setUpdateValue(e.target.value)}
              placeholder="0.00"
              style={{
                width: 140,
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
              As of (optional)
            </label>
            <input
              type="date"
              value={updateDate}
              onChange={(e) => setUpdateDate(e.target.value)}
              style={{
                width: 140,
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
            onClick={handleUpdateBalance}
            disabled={updating || !updateValue}
            style={{
              padding: '5px 16px',
              borderRadius: 4,
              border: 'none',
              background: '#818cf8',
              color: '#fff',
              fontSize: 12,
              cursor: updating ? 'wait' : 'pointer',
              opacity: updating || !updateValue ? 0.5 : 1,
            }}
          >
            {updating ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={() => setShowUpdateForm(false)}
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

      {(perfHistory.length > 0 || balances.length > 0) && (() => {
        const startDate = getStartDate(range)
        // Prefer performance history (daily data) over balance snapshots
        const chartData = perfHistory.length > 0
          ? perfHistory.map((p) => ({ date: p.date, balance: p.balance }))
          : balances.map((b) => ({ date: b.date, balance: b.balance }))
        let filtered: typeof chartData
        if (startDate) {
          // Include the last point before startDate to anchor the chart
          const before = chartData.filter((d) => d.date < startDate)
          const inRange = chartData.filter((d) => d.date >= startDate)
          const anchor = before.length > 0
            ? [{ date: startDate, balance: before[before.length - 1].balance }]
            : []
          filtered = [...anchor, ...inRange]
        } else {
          filtered = chartData
        }
        if (filtered.length === 0) return null
        return (
        <div className="card" style={{ padding: '12px 0', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 16px 8px' }}>
            <TimeRangeSelector value={range} onChange={setRange} />
          </div>
          <Plot
            data={[
              {
                x: filtered.map((d) => d.date),
                y: filtered.map((d) => d.balance),
                type: 'scatter',
                mode: 'lines',
                line: { color: '#818cf8', width: 2 },
                fill: 'tozeroy',
                fillcolor: 'rgba(129, 140, 248, 0.08)',
                hovertemplate: '%{x}<br>$%{y:,.0f}<extra></extra>',
              },
            ]}
            layout={{
              paper_bgcolor: 'transparent',
              plot_bgcolor: 'transparent',
              font: { color: 'rgba(255,255,255,0.6)', size: 11 },
              margin: { l: 60, r: 20, t: 10, b: 40 },
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
        )
      })()}

      {holdings.length > 0 && (
        <>
          <h3 style={{ marginTop: '1.5rem', marginBottom: '0.5rem' }}>Holdings</h3>
          <table className="accounts-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Name</th>
                <th>Asset Class</th>
                <th className="right">Shares</th>
                <th className="right">Value</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h, i) => (
                <tr key={`${h.symbol}-${i}`}>
                  <td style={{ fontWeight: 600 }}>{h.symbol}</td>
                  <td className="dim">{h.name}</td>
                  <td className="dim">{h.asset_class}</td>
                  <td className="right">{h.shares.toFixed(4)}</td>
                  <td className="amount right">{fmtDollar(h.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {transactions.length > 0 && (() => {
        const startDate = getStartDate(range)
        const filteredTxns = startDate
          ? transactions.filter((t) => t.date >= startDate)
          : transactions
        return filteredTxns.length > 0 && (
        <>
          <h3 style={{ marginTop: '1.5rem', marginBottom: '0.5rem' }}>
            Transactions
          </h3>
          <table className="accounts-table" style={{ fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Category</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {filteredTxns.map((t) => (
                <tr key={t.id}>
                  <td className="dim">{t.date}</td>
                  <td>{t.description ?? '—'}</td>
                  <td className="dim">{t.category_path ?? t.category ?? '—'}</td>
                  <td className={`amount right${t.amount < 0 ? ' negative' : ''}`}>
                    {fmtDollar(t.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
        )
      })()}

      {balances.length === 0 && holdings.length === 0 && transactions.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'rgba(255,255,255,0.4)' }}>
          No data yet for this account.
          {isManual && ' Use the "Update Value" button to add a balance.'}
        </div>
      )}
    </section>
  )
}
