import type { Activity, Itinerary } from "./types";

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

/** Build a Google Maps URL for an activity based on available location data */
export function mapsUrl(activity: Activity): string | null {
  if (activity.placeId) return `https://www.google.com/maps/place/?q=place_id:${activity.placeId}`;
  if (activity.lat != null && activity.lng != null) return `https://www.google.com/maps/@${activity.lat},${activity.lng},15z`;
  if (activity.location) return `https://www.google.com/maps/search/${encodeURIComponent(activity.location)}`;
  return null;
}

/** Build a Google Maps *directions* URL — user's current location → activity.
 *  Opens the Maps app with navigation ready to start. */
export function directionsUrl(activity: Activity): string | null {
  const base = "https://www.google.com/maps/dir/?api=1";
  if (activity.lat != null && activity.lng != null) {
    const dest = `${activity.lat},${activity.lng}`;
    const qs = activity.placeId ? `&destination_place_id=${activity.placeId}` : "";
    return `${base}&destination=${dest}${qs}`;
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
