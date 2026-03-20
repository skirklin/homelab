import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import type { NetWorthSummary } from './api'
import { fetchAccounts, fetchNetWorthSummary } from './api'
import { Overview } from './pages/Overview'
import { Investments } from './pages/Investments'
import { Spending } from './pages/Spending'
import { Travel } from './pages/Travel'
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
        <span className="net-worth-value">{fmtDollar(summary.liquid_plus_vested)}</span>
        <span className="net-worth-label">+ Vested</span>
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
            <NavLink to="/travel">Travel</NavLink>
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<Overview accounts={accounts} />} />
            <Route path="/investments" element={<Investments />} />
            <Route path="/spending" element={<Spending />} />
            <Route path="/travel" element={<Travel />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

export default App
