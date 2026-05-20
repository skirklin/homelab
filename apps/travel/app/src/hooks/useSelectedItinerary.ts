/**
 * Resolve the "currently selected itinerary" for a trip given the `?itin=…`
 * search param.
 *
 * Resolution order:
 *   1. If `?itin=<id>` matches one of the supplied itineraries, return it.
 *   2. Otherwise, fall back to the itinerary flagged `isActive`.
 *   3. Otherwise, fall back to the first itinerary in the list.
 *   4. If the list is empty, return undefined.
 *
 * Important: a stale or bogus `?itin=` (id no longer present, e.g. after
 * deletion) falls through to the active/first itinerary rather than returning
 * undefined. This matches the DayView/TripDetail behavior; ItinerarySection
 * previously returned the stale id directly and rendered nothing.
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { Itinerary } from "../types";

/**
 * Pure resolver used by the hook. Exported for testing.
 */
export function resolveSelectedItinerary(
  itineraries: Itinerary[],
  selectedId: string | null | undefined,
): Itinerary | undefined {
  if (itineraries.length === 0) return undefined;
  if (selectedId) {
    const match = itineraries.find((i) => i.id === selectedId);
    if (match) return match;
  }
  return itineraries.find((i) => i.isActive) ?? itineraries[0];
}

export function useSelectedItinerary(
  itineraries: Itinerary[],
): Itinerary | undefined {
  const [searchParams] = useSearchParams();
  const selectedId = searchParams.get("itin");
  return useMemo(
    () => resolveSelectedItinerary(itineraries, selectedId),
    [itineraries, selectedId],
  );
}
