import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Transaction, TripSummary } from '../api'
import { fetchTransactions, fetchTravelTrips } from '../api'
import { CategoryChart } from '../components/CategoryChart'

export function Travel() {
  const [allTxns, setAllTxns] = useState<Transaction[]>([])
  const [trips, setTrips] = useState<TripSummary[]>([])

  useEffect(() => {
    fetchTransactions({ limit: 10000, hideTransfers: true }).then(setAllTxns)
    fetchTravelTrips().then(setTrips)
  }, [])

  // Build a map from date ranges to trip names
  const tripLookup = useMemo(() => {
    return trips.filter((t) => t.name !== 'Other Travel').map((t) => ({
      name: t.name,
      start: t.start,
      end: t.end,
    }))
  }, [trips])

  // Filter to travel transactions only
  const travelTxns = useMemo(() => {
    return allTxns.filter((t) => {
      if (t.amount >= 0) return false
      const path = t.category_path ?? ''
      return path === 'travel' || path.startsWith('travel/')
    })
  }, [allTxns])

  // Group by trip name (match by date range)
  const groupFn = useCallback((t: Transaction) => {
    for (const trip of tripLookup) {
      if (trip.start && trip.end && t.date >= trip.start && t.date <= trip.end) {
        return trip.name
      }
    }
    return 'other'
  }, [tripLookup])

  if (allTxns.length === 0) return null

  return (
    <CategoryChart
      transactions={travelTxns}
      groupFn={groupFn}
      breadcrumbs={[{ label: 'travel by trip', onClick: () => {} }]}
    />
  )
}
