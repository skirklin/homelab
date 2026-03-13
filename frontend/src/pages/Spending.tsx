import { useEffect, useState } from 'react'
import type { Account } from '../api'
import { fetchAccounts } from '../api'
import { SpendingByMonth, SpendingByCategory } from '../components/SpendingCharts'
import { TransactionTable } from '../components/TransactionTable'

export function Spending() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedAccount, setSelectedAccount] = useState<string | undefined>()

  useEffect(() => {
    fetchAccounts().then(setAccounts)
  }, [])

  return (
    <>
      <div className="spending-grid">
        <SpendingByMonth />
        <SpendingByCategory />
      </div>
      <TransactionTable
        accounts={accounts}
        accountId={selectedAccount}
        onAccountChange={setSelectedAccount}
      />
    </>
  )
}
