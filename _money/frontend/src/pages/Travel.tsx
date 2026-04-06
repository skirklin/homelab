import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Transaction, TripSummary } from '../api'
import { fetchTransactions, fetchTravelTrips } from '../api'
import { CategoryChart } from '../components/CategoryChart'

export function Travel() {
  const [allTxns, setAllTxns] = useState<Transaction[]>([])
  const [trips, setTrips] = useState<TripSummary[]>([])
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null)
  const [selectedSubcat, setSelectedSubcat] = useState<string | null>(null)

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

  const assignTrip = useCallback((t: Transaction): string | null => {
    for (const trip of tripLookup) {
      if (trip.start && trip.end && t.date >= trip.start && t.date <= trip.end) {
        return trip.name
      }
    }
    return null
  }, [tripLookup])

  const getSubcat = useCallback((t: Transaction): string => {
    const path = t.category_path ?? ''
    const rest = path.startsWith('travel/') ? path.slice(7) : path
    return rest || 'other'
  }, [])

  const filteredTxns = useMemo(() => {
    let txns = travelTxns
    if (selectedTrip) {
      txns = txns.filter((t) => assignTrip(t) === selectedTrip)
    }
    if (selectedSubcat) {
      txns = txns.filter((t) => getSubcat(t) === selectedSubcat)
    }
    return txns
  }, [travelTxns, selectedTrip, selectedSubcat, assignTrip, getSubcat])

  const groupFn = useCallback((t: Transaction) => {
    if (selectedSubcat) {
      // Leaf — return a single group so CategoryChart shows transactions
      return selectedSubcat
    }
    if (selectedTrip) {
      return getSubcat(t)
    }
    return assignTrip(t)
  }, [selectedTrip, selectedSubcat, assignTrip, getSubcat])

  const breadcrumbs = useMemo(() => {
    const crumbs = [{
      label: 'travel by trip',
      onClick: () => { setSelectedTrip(null); setSelectedSubcat(null) },
    }]
    if (selectedTrip) {
      crumbs.push({
        label: selectedTrip,
        onClick: () => { setSelectedSubcat(null) },
      })
    }
    if (selectedSubcat) {
      crumbs.push({ label: selectedSubcat, onClick: () => {} })
    }
    return crumbs
  }, [selectedTrip, selectedSubcat])

  const handleCategoryClick = useCallback((category: string) => {
    if (!selectedTrip) {
      setSelectedTrip(category)
    } else if (!selectedSubcat) {
      setSelectedSubcat(category)
    }
  }, [selectedTrip, selectedSubcat])

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
