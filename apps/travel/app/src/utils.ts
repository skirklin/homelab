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

/** Build a Google Maps URL for an activity based on available location data */
export function mapsUrl(activity: Activity): string | null {
  if (activity.placeId) return `https://www.google.com/maps/place/?q=place_id:${activity.placeId}`;
  if (activity.lat != null && activity.lng != null) return `https://www.google.com/maps/@${activity.lat},${activity.lng},15z`;
  if (activity.location) return `https://www.google.com/maps/search/${encodeURIComponent(activity.location)}`;
  return null;
}

/** Build a Google Maps *directions* URL — user's current location → activity.
 *  Opens the Maps app with navigation ready to start.
 *
 *  When a placeId exists we prefer it as the sole destination signal — Maps
 *  routes to the authoritative place. Mixing placeId with lat/lng causes the
 *  mobile app to route to the (sometimes stale or slightly off) coordinates
 *  even though the place card looks correct. */
export function directionsUrl(activity: Activity): string | null {
  const base = "https://www.google.com/maps/dir/?api=1";
  if (activity.placeId) {
    // `destination` is required; pass the name as label text so users see
    // something readable if Maps falls back to a search.
    const label = encodeURIComponent(activity.name || activity.location || "destination");
    return `${base}&destination=${label}&destination_place_id=${activity.placeId}`;
  }
  if (activity.lat != null && activity.lng != null) {
    return `${base}&destination=${activity.lat},${activity.lng}`;
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
