// Trip status values
export type TripStatus = "Completed" | "Booked" | "Researching" | "Idea" | "Ongoing";

// Booking requirement on an activity
export interface BookingRequirement {
  daysBefore: number; // days before trip start to take action
  action: string; // what to do, e.g. "Book tickets at museofridakahlo.org.mx"
  done?: boolean; // tracked per-activity, not per-trip
}

// Activity categories
export type ActivityCategory =
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
  confirmationCode: string;
  details: string;
  setting: "outdoor" | "indoor" | "either" | "";
  bookingReqs: BookingRequirement[];
  rating: number | null;
  ratingCount: number | null;
  photoRef: string;
  tripId: string;
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

/** Parse a duration string like "2-3 hours", "45m", "half day", "evening" into hours */
export function parseDurationHours(dur: string): number {
  if (!dur) return 0;
  const d = dur.toLowerCase().trim();
  if (d === "full day") return 6;
  if (d === "half day") return 3;
  if (d === "evening") return 3;
  // "2-3 hours" -> average
  const rangeHr = d.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*h/);
  if (rangeHr) return (parseFloat(rangeHr[1]) + parseFloat(rangeHr[2])) / 2;
  // "2h", "2 hours", "2.5h"
  const singleHr = d.match(/^(\d+(?:\.\d+)?)\s*h/);
  if (singleHr) return parseFloat(singleHr[1]);
  // "45m", "45 min", "30 min"
  const mins = d.match(/^(\d+)\s*m/);
  if (mins) return parseInt(mins[1]) / 60;
  // "4.5 hours"
  const hoursWord = d.match(/(\d+(?:\.\d+)?)\s*hours?/);
  if (hoursWord) return parseFloat(hoursWord[1]);
  return 0;
}

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
