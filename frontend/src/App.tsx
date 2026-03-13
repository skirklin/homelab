import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import type { Account } from './api'
import { fetchAccounts } from './api'
import { Overview } from './pages/Overview'
import { Investments } from './pages/Investments'
import { Spending } from './pages/Spending'
import './App.css'

const fmtDollar = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function App() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchAccounts()
      .then((accts) => {
        setAccounts(accts)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  if (loading) return <div className="loading">Loading...</div>
  if (error) return <div className="error">Error: {error}</div>

  const totalBalance = accounts.reduce((sum, a) => sum + (a.latest_balance ?? 0), 0)

  return (
    <BrowserRouter>
      <div className="app">
        <header>
          <h1>Money</h1>
          <div className="net-worth-header">{fmtDollar(totalBalance)}</div>
          <nav className="nav">
            <NavLink to="/" end>Overview</NavLink>
            <NavLink to="/investments">Investments</NavLink>
            <NavLink to="/spending">Spending</NavLink>
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<Overview accounts={accounts} />} />
            <Route path="/investments" element={<Investments />} />
            <Route path="/spending" element={<Spending />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

export default App
