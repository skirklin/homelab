import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Transaction, TripSummary } from '../api'
import { fetchTransactions, fetchTravelTrips } from '../api'
import { CategoryChart } from '../components/CategoryChart'

export function Travel() {
  const [allTxns, setAllTxns] = useState<Transaction[]>([])
  const [trips, setTrips] = useState<TripSummary[]>([])
  const [searchParams, setSearchParams] = useSearchParams()

  // Drilldown state lives in the URL so back button steps out one level
  // (overview ← trip ← subcategory) instead of exiting /travel entirely.
  const selectedTrip = searchParams.get('trip')
  const selectedSubcat = searchParams.get('subcat')

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

  // Breadcrumb-up: replace (don't push a new history entry just for going back up).
  const goToOverview = useCallback(() => {
    setSearchParams({}, { replace: true })
  }, [setSearchParams])

  const goToTrip = useCallback((trip: string) => {
    setSearchParams({ trip }, { replace: true })
  }, [setSearchParams])

  // Drilldown: push so the browser back button steps out one level.
  const drillToTrip = useCallback((trip: string) => {
    setSearchParams({ trip })
  }, [setSearchParams])

  const drillToSubcat = useCallback((subcat: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('subcat', subcat)
      return next
    })
  }, [setSearchParams])

  const breadcrumbs = useMemo(() => {
    const crumbs = [{
      label: 'travel by trip',
      onClick: goToOverview,
    }]
    if (selectedTrip) {
      crumbs.push({
        label: selectedTrip,
        onClick: () => goToTrip(selectedTrip),
      })
    }
    if (selectedSubcat) {
      crumbs.push({ label: selectedSubcat, onClick: () => {} })
    }
    return crumbs
  }, [selectedTrip, selectedSubcat, goToOverview, goToTrip])

  const handleCategoryClick = useCallback((category: string) => {
    if (!selectedTrip) {
      drillToTrip(category)
    } else if (!selectedSubcat) {
      drillToSubcat(category)
    }
  }, [selectedTrip, selectedSubcat, drillToTrip, drillToSubcat])

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
