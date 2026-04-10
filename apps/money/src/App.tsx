import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import type { Account, NetWorthSummary } from './api'
import { fetchAccounts, fetchNetWorthSummary } from './api'
import { Overview } from './pages/Overview'
import { Investments } from './pages/Investments'
import { Spending } from './pages/Spending'
import { Transactions } from './pages/Transactions'
import { Travel } from './pages/Travel'
import { Accounts } from './pages/Accounts'
import AccountDetail from './pages/AccountDetail'
import PersonDetail from './pages/PersonDetail'
import InstitutionDetail from './pages/InstitutionDetail'
import { Settings } from './pages/Settings'
import './App.css'

const fmtDollar = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

function NetWorthHeader({ summary }: { summary: NetWorthSummary | null }) {
  if (!summary) return null

  return (
    <div className="net-worth-header">
      <div className="net-worth-tier">
        <span className="net-worth-value">{fmtDollar(summary.liquid)}</span>
        <span className="net-worth-label">Liquid</span>
      </div>
      <div className="net-worth-tier">
        <span className="net-worth-value">{fmtDollar(summary.liquid_plus_vested_after_tax)}</span>
        <span className="net-worth-label">+ Vested (after tax)</span>
      </div>
      <div className="net-worth-tier">
        <span className="net-worth-value">{fmtDollar(summary.liquid_plus_all_equity)}</span>
        <span className="net-worth-label">+ All Equity</span>
      </div>
    </div>
  )
}

function App() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [netWorth, setNetWorth] = useState<NetWorthSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([fetchAccounts(), fetchNetWorthSummary()])
      .then(([accts, nw]) => {
        setAccounts(accts)
        setNetWorth(nw)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  if (loading) return <div className="loading">Loading...</div>
  if (error) return <div className="error">Error: {error}</div>

  return (
    <BrowserRouter>
      <div className="app">
        <header>
          <h1>Money</h1>
          <NetWorthHeader summary={netWorth} />
          <nav className="nav">
            <NavLink to="/" end>Overview</NavLink>
            <NavLink to="/investments">Investments</NavLink>
            <NavLink to="/spending">Spending</NavLink>
            <NavLink to="/transactions">Transactions</NavLink>
            <NavLink to="/travel">Travel</NavLink>
            <NavLink to="/accounts">Accounts</NavLink>
            <NavLink to="/settings" title="Settings" style={{ opacity: 0.5, fontSize: '0.9em' }}>&#9881;</NavLink>
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<Overview accounts={accounts} />} />
            <Route path="/investments" element={<Investments />} />
            <Route path="/spending" element={<Spending />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/travel" element={<Travel />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/accounts/:id" element={<AccountDetail />} />
            <Route path="/people/:person" element={<PersonDetail />} />
            <Route path="/institutions/:institution" element={<InstitutionDetail />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

export default App
