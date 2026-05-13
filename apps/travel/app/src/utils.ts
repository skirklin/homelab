import type { Activity, Itinerary, DayEntry } from "./types";

/** Get activities for a specific trip */
export function getActivitiesForTrip(
  activities: Map<string, Activity>,
  tripId: string
) {
  return Array.from(activities.values()).filter((a) => a.tripId === tripId);
}

/** Get itineraries for a specific trip */
export function getItinerariesForTrip(
  itineraries: Map<string, Itinerary>,
  tripId: string
) {
  return Array.from(itineraries.values()).filter((i) => i.tripId === tripId);
}

/** Get day journal entries for a specific trip, sorted by date ascending. */
export function getDayEntriesForTrip(
  entries: Map<string, DayEntry>,
  tripId: string,
) {
  return Array.from(entries.values())
    .filter((e) => e.tripId === tripId)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Build a Google Maps URL for an activity based on available location data.
 *
 *  Prefers coords because the resulting `/maps/search/?api=1&query=lat,lng`
 *  URL renders a pin offline (Google Maps caches the basemap; placeId
 *  resolution requires a network round-trip). When both coords and placeId
 *  exist, attach the placeId so the place card is enriched when online. */
export function mapsUrl(activity: Activity): string | null {
  const base = "https://www.google.com/maps/search/?api=1";
  if (activity.lat != null && activity.lng != null) {
    const placeSuffix = activity.placeId ? `&query_place_id=${activity.placeId}` : "";
    return `${base}&query=${activity.lat},${activity.lng}${placeSuffix}`;
  }
  if (activity.placeId) {
    // No coords — fall back to the place-lookup URL. Requires online.
    return `https://www.google.com/maps/place/?q=place_id:${activity.placeId}`;
  }
  if (activity.location) return `${base}&query=${encodeURIComponent(activity.location)}`;
  return null;
}

/** Build a Google Maps *directions* URL — user's current location → activity.
 *  Opens the Maps app with navigation ready to start.
 *
 *  Same coords-first preference as mapsUrl: a coords destination is
 *  resolvable offline, and the placeId enriches the routing when online. */
export function directionsUrl(activity: Activity): string | null {
  const base = "https://www.google.com/maps/dir/?api=1";
  if (activity.lat != null && activity.lng != null) {
    const placeSuffix = activity.placeId ? `&destination_place_id=${activity.placeId}` : "";
    return `${base}&destination=${activity.lat},${activity.lng}${placeSuffix}`;
  }
  if (activity.placeId) {
    // No coords — placeId alone, with a readable label fallback.
    const label = encodeURIComponent(activity.name || activity.location || "destination");
    return `${base}&destination=${label}&destination_place_id=${activity.placeId}`;
  }
  if (activity.location) return `${base}&destination=${encodeURIComponent(activity.location)}`;
  return null;
}

/** Build a URL for a source reference line (Gmail, Calendar, Drive) */
export function sourceRefUrl(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("Gmail:")) return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(trimmed.slice(6).trim())}`;
  if (trimmed.startsWith("Calendar:")) return "https://calendar.google.com";
  if (trimmed.startsWith("Drive:")) return `https://drive.google.com/drive/search?q=${encodeURIComponent(trimmed.slice(6).trim())}`;
  return null;
}
