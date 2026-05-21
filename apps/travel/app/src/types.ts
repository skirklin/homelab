// Validation primitives — canonical impl lives in @homelab/backend so the UI
// and the MCP server can't drift. Re-exported here so callsites that do
// `import { validateDay, ... } from "../types"` keep working unchanged.
import {
  validateDay,
  parseTimeOfDay,
  parseDurationHours,
} from "@homelab/backend";
export { validateDay, parseTimeOfDay, parseDurationHours };
export type {
  DayIssue,
  DayIssueKind,
  ValidationActivity,
  ValidationSlot,
} from "@homelab/backend";

// Trip status values
export type TripStatus = "Completed" | "Booked" | "Researching" | "Idea" | "Ongoing";

// Activity categories
export type ActivityCategory =
  | "Flight"
  | "Transportation"
  | "Accommodation"
  | "Hiking"
  | "Adventure"
  | "Food & Dining"
  | "Sightseeing"
  | "Shopping"
  | "Nightlife"
  | "Culture"
  | "Relaxation"
  | "Other";

// Structured flight data (only meaningful for category === "Flight")
export interface FlightInfo {
  airline?: string;       // e.g. "United", "UA"
  number?: string;        // e.g. "1234"
  from?: string;          // departure airport code, e.g. "SFO"
  to?: string;            // arrival airport code, e.g. "JFK"
  fromLat?: number;
  fromLng?: number;
  toLat?: number;
  toLng?: number;
  departsAt?: string;     // ISO datetime
  arrivesAt?: string;     // ISO datetime
  // Mark one end as "home" to keep that bookend leg off the itinerary map —
  // otherwise the map stretches all the way back to the home airport.
  fromIsHome?: boolean;
  toIsHome?: boolean;
}

// ==========================================
// Travel Log (container)
// ==========================================

export interface TravelLog {
  id: string;
  name: string;
  owners: string[];
  created: Date;
  updated: Date;
}

// ==========================================
// Trip
// ==========================================

export interface Trip {
  id: string;
  destination: string;
  status: TripStatus;
  region: string;
  startDate: Date | null;
  endDate: Date | null;
  notes: string;
  sourceRefs: string;
  flaggedForReview: boolean;
  reviewComment: string;
  created: Date;
  updated: Date;
}

// ==========================================
// Activity
// ==========================================

export type ActivityVerdict = "loved" | "liked" | "meh" | "skip";

export type HikeDifficulty = "easy" | "moderate" | "hard" | "strenuous";

export const HIKE_DIFFICULTIES: HikeDifficulty[] = ["easy", "moderate", "hard", "strenuous"];

export interface Activity {
  id: string;
  name: string;
  category: ActivityCategory;
  location: string;
  placeId: string;
  lat: number | null;
  lng: number | null;
  description: string;
  costNotes: string;
  durationEstimate: string;
  walkMiles: number | null;
  elevationGainFeet: number | null;
  difficulty: HikeDifficulty | "";
  confirmationCode: string;
  details: string;
  setting: "outdoor" | "indoor" | "either" | "";
  rating: number | null;
  ratingCount: number | null;
  photoRef: string;
  flightInfo?: FlightInfo;
  // Post-experience reflection (kept distinct from `rating`/`ratingCount`,
  // which are Google Places aggregates).
  verdict?: ActivityVerdict;
  personalNotes?: string;
  experiencedAt?: Date;
  tripId: string;
  created: Date;
  updated: Date;
}

export interface DayEntry {
  id: string;
  tripId: string;
  date: string; // YYYY-MM-DD
  text: string;
  highlight: string;
  mood: number | null;
  created: Date;
  updated: Date;
}

// ==========================================
// Itinerary
// ==========================================

export interface ItinerarySlot {
  activityId: string;
  startTime?: string;
  notes?: string;
}

export interface ItineraryDay {
  date?: string; // ISO date for completed trips, empty for hypothetical
  label: string; // "Day 2 -- Sun Sep 8: Zion Narrows"
  lodgingActivityId?: string; // The accommodation for this night
  flights?: ItinerarySlot[]; // Flights/major transport for this day
  slots: ItinerarySlot[]; // Activities (excluding lodging and flights)
}

export interface Itinerary {
  id: string;
  tripId: string;
  name: string; // "Actual" for completed, "Option A" for ideas
  isActive: boolean;
  days: ItineraryDay[];
  created: Date;
  updated: Date;
}

// ==========================================
// User profile extension
// ==========================================

export type { UserProfile, UserProfileStore } from "@kirkl/shared";

// Status display helpers
export const STATUS_COLORS: Record<TripStatus, string> = {
  Completed: "#52c41a",
  Booked: "#1677ff",
  Ongoing: "#fa8c16",
  Researching: "#722ed1",
  Idea: "#8c8c8c",
};

export const STATUS_ORDER: TripStatus[] = [
  "Ongoing",
  "Booked",
  "Researching",
  "Idea",
  "Completed",
];

export function formatDateRange(trip: Trip): string {
  if (!trip.startDate) return "";
  const start = trip.startDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (!trip.endDate) return start;
  const end = trip.endDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${start} — ${end}`;
}

// ==========================================
// Geo utilities
// ==========================================

// `parseDurationHours` / `parseTimeOfDay` are imported at the top of this file
// from @homelab/backend (and re-exported there); their local copies used to
// live in this section.

/** Estimate driving time in hours from haversine distance (rough: 30mph average with stops) */
export function estimateDriveHours(miles: number): number {
  if (miles <= 0) return 0;
  return miles / 30;
}

/** Haversine distance in miles between two lat/lng points */
export function haversineDistance(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 3959; // Earth radius in miles
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sin2Lat = Math.sin(dLat / 2) ** 2;
  const sin2Lng = Math.sin(dLng / 2) ** 2;
  const h = sin2Lat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sin2Lng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface DayLoad {
  activityHours: number;
  driveHours: number;
  driveMiles: number;
  totalHours: number;
  level: "light" | "moderate" | "full" | "overpacked";
}

/** Calculate the load for a day's activities */
export function calculateDayLoad(activities: Activity[]): DayLoad {
  const activityHours = activities.reduce((sum, a) => sum + parseDurationHours(a.durationEstimate), 0);
  const driveMiles = dayTravelDistance(activities);
  const driveHours = estimateDriveHours(driveMiles);
  const totalHours = activityHours + driveHours;

  let level: DayLoad["level"];
  if (totalHours <= 4) level = "light";
  else if (totalHours <= 7) level = "moderate";
  else if (totalHours <= 10) level = "full";
  else level = "overpacked";

  return { activityHours, driveHours, driveMiles, totalHours, level };
}

/** Total travel distance for a sequence of activities (skips those without coords) */
export function dayTravelDistance(activities: Activity[]): number {
  const withCoords = activities.filter((a) => a.lat != null && a.lng != null);
  if (withCoords.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < withCoords.length; i++) {
    total += haversineDistance(
      { lat: withCoords[i - 1].lat!, lng: withCoords[i - 1].lng! },
      { lat: withCoords[i].lat!, lng: withCoords[i].lng! }
    );
  }
  return total;
}

// ==========================================
// Day-of-trip helpers
// ==========================================

/** Local-timezone YYYY-MM-DD string for a Date (matches ItineraryDay.date). */
export function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** A trip is "active" if `now` (date portion) falls within [startDate, endDate] inclusive. */
export function isTripActive(trip: Trip, now: Date): boolean {
  if (!trip.startDate || !trip.endDate) return false;
  const today = localYmd(now);
  return localYmd(trip.startDate) <= today && today <= localYmd(trip.endDate);
}

/** Find the ItineraryDay whose `date` matches today, with its index. */
export function findTodayDay(
  itinerary: Itinerary,
  now: Date,
): { day: ItineraryDay; index: number } | null {
  const today = localYmd(now);
  for (let i = 0; i < itinerary.days.length; i++) {
    if (itinerary.days[i].date === today) return { day: itinerary.days[i], index: i };
  }
  return null;
}

export interface ScheduledSlot {
  slot: ItinerarySlot;
  activity: Activity;
  startMin: number;
  endMin: number; // startMin + duration (= startMin if unparseable)
  source: "flights" | "slots";
}

/**
 * Flatten a day's flights + slots into chronologically-sorted scheduled entries.
 * Unscheduled slots (no startTime) and slots referencing a missing activity are
 * dropped — callers who need the raw list should read `day.slots` directly.
 */
export function scheduledEntriesForDay(
  day: ItineraryDay,
  activityMap: Map<string, Activity>,
): ScheduledSlot[] {
  const out: ScheduledSlot[] = [];
  const pushFrom = (list: ItinerarySlot[] | undefined, source: ScheduledSlot["source"]) => {
    for (const slot of list ?? []) {
      const startMin = parseTimeOfDay(slot.startTime);
      if (startMin == null) continue;
      const activity = activityMap.get(slot.activityId);
      if (!activity) continue;
      const durHours = parseDurationHours(activity.durationEstimate);
      out.push({ slot, activity, startMin, endMin: startMin + durHours * 60, source });
    }
  };
  pushFrom(day.flights, "flights");
  pushFrom(day.slots, "slots");
  out.sort((a, b) => a.startMin - b.startMin);
  return out;
}

/** The scheduled entry whose [startMin, endMin) covers `now`, or null. */
export function findCurrentEntry(
  entries: ScheduledSlot[],
  now: Date,
): ScheduledSlot | null {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const e of entries) {
    if (e.endMin <= e.startMin) continue; // no known duration, can't define "covers"
    if (nowMin >= e.startMin && nowMin < e.endMin) return e;
  }
  return null;
}

/** The next scheduled entry whose startMin is strictly greater than now. */
export function findNextEntry(
  entries: ScheduledSlot[],
  now: Date,
): { entry: ScheduledSlot; minutesUntil: number } | null {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const e of entries) {
    if (e.startMin > nowMin) return { entry: e, minutesUntil: e.startMin - nowMin };
  }
  return null;
}

/** Format minutes-from-now as "in 35 min" / "in 2h 15m" / "now". */
export function formatCountdown(minutes: number): string {
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes - h * 60;
  if (m === 0) return `in ${h}h`;
  return `in ${h}h ${m}m`;
}
