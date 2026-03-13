import { useEffect, useState } from 'react'
import type { Account } from './api'
import { fetchAccounts } from './api'
import { NetWorthChart } from './components/NetWorthChart'
import { AccountSummary } from './components/AccountSummary'
import { PerformanceChart } from './components/PerformanceChart'
import { SpendingByMonth, SpendingByCategory } from './components/SpendingCharts'
import { TransactionTable } from './components/TransactionTable'
import './App.css'

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
    <div className="app">
      <header>
        <h1>Money</h1>
        <div className="net-worth-header">
          $
          {totalBalance.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </div>
      </header>
      <main>
        <NetWorthChart />
        <AccountSummary accounts={accounts} />
        <PerformanceChart />
        <div className="spending-grid">
          <SpendingByMonth />
          <SpendingByCategory />
        </div>
        <TransactionTable />
      </main>
    </div>
  )
}

export default App
