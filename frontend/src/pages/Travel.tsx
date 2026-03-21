import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Transaction, TripSummary } from '../api'
import { fetchTransactions, fetchTravelTrips } from '../api'
import { CategoryChart } from '../components/CategoryChart'

export function Travel() {
  const [allTxns, setAllTxns] = useState<Transaction[]>([])
  const [trips, setTrips] = useState<TripSummary[]>([])
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null)

  useEffect(() => {
    fetchTransactions({ limit: 10000, hideTransfers: true }).then(setAllTxns)
    fetchTravelTrips().then(setTrips)
  }, [])

  const tripLookup = useMemo(() => {
    return trips.filter((t) => t.name !== 'Other Travel').map((t) => ({
      name: t.name,
      start: t.start,
      end: t.end,
    }))
  }, [trips])

  const travelTxns = useMemo(() => {
    return allTxns.filter((t) => {
      if (t.amount >= 0) return false
      const path = t.category_path ?? ''
      return path === 'travel' || path.startsWith('travel/')
    })
  }, [allTxns])

  // Assign trip name to each transaction
  const assignTrip = useCallback((t: Transaction): string | null => {
    for (const trip of tripLookup) {
      if (trip.start && trip.end && t.date >= trip.start && t.date <= trip.end) {
        return trip.name
      }
    }
    return null
  }, [tripLookup])

  // When drilled into a trip, filter to that trip and group by category
  const filteredTxns = useMemo(() => {
    if (!selectedTrip) return travelTxns
    return travelTxns.filter((t) => assignTrip(t) === selectedTrip)
  }, [travelTxns, selectedTrip, assignTrip])

  const groupFn = useCallback((t: Transaction) => {
    if (selectedTrip) {
      // Drilled into a trip — group by travel subcategory
      const path = t.category_path ?? ''
      const rest = path.startsWith('travel/') ? path.slice(7) : path
      return rest || 'other'
    }
    return assignTrip(t)
  }, [selectedTrip, assignTrip])

  const breadcrumbs = useMemo(() => {
    const crumbs = [{ label: 'travel by trip', onClick: () => setSelectedTrip(null) }]
    if (selectedTrip) {
      crumbs.push({ label: selectedTrip, onClick: () => {} })
    }
    return crumbs
  }, [selectedTrip])

  const handleCategoryClick = useCallback((category: string) => {
    if (!selectedTrip) {
      setSelectedTrip(category)
    }
  }, [selectedTrip])

  if (allTxns.length === 0) return null

  return (
    <CategoryChart
      transactions={filteredTxns}
      groupFn={groupFn}
      onCategoryClick={handleCategoryClick}
      breadcrumbs={breadcrumbs}
    />
  )
}
