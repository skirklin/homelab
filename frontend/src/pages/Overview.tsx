import type { Account } from '../api'
import { NetWorthChart } from '../components/NetWorthChart'
import { AccountSummary } from '../components/AccountSummary'

interface Props {
  accounts: Account[]
}

export function Overview({ accounts }: Props) {
  return (
    <>
      <NetWorthChart />
      <AccountSummary accounts={accounts} />
    </>
  )
}
