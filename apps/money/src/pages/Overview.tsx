import type { Account } from '../api'
import { NetWorthChart } from '../components/NetWorthChart'
import { AccountSummary } from '../components/AccountSummary'
import { SyncStatusCompact } from '../components/SyncStatus'

interface Props {
  accounts: Account[]
}

export function Overview({ accounts }: Props) {
  return (
    <>
      <SyncStatusCompact />
      <div className="overview-layout">
        <AccountSummary accounts={accounts} />
        <div className="overview-main">
          <NetWorthChart />
        </div>
      </div>
    </>
  )
}
