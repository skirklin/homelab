import { Timestamp } from "firebase/firestore";

// Trip status values
export type TripStatus = "Completed" | "Booked" | "Researching" | "Idea" | "Ongoing";

// Checklist templates (stored on the travel log, shared across trips)
export interface ChecklistTemplate {
  id: string;
  name: string; // "General Trip Prep", "International", "Camping"
  items: ChecklistTemplateItem[];
}

export interface ChecklistTemplateItem {
  id: string;
  text: string;
  category: string; // "logistics", "packing", "people", "documents", "prep"
}

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
  checklists: ChecklistTemplate[];
  created: Date;
  updated: Date;
}

export interface TravelLogStore {
  name: string;
  owners: string[];
  checklists?: ChecklistTemplate[];
  created: Timestamp;
  updated: Timestamp;
}

export const DEFAULT_CHECKLIST: ChecklistTemplate = {
  id: "general",
  name: "General Trip Prep",
  items: [
    { id: "weather", text: "Check weather forecast for trip dates", category: "prep" },
    { id: "people", text: "Reach out to anyone I know in the area", category: "people" },
    { id: "maps", text: "Download offline maps for the area", category: "prep" },
    { id: "bank", text: "Notify bank of travel dates", category: "documents" },
    { id: "insurance", text: "Check travel insurance coverage", category: "documents" },
    { id: "mail", text: "Hold mail / arrange package pickup", category: "prep" },
    { id: "pets", text: "Arrange pet care", category: "prep" },
    { id: "plants", text: "Arrange plant watering", category: "prep" },
    { id: "chargers", text: "Charge all devices, pack chargers", category: "packing" },
    { id: "meds", text: "Pack medications and first aid", category: "packing" },
    { id: "copies", text: "Save copies of confirmations offline", category: "documents" },
    { id: "checkin", text: "Check in for flights (24h before)", category: "logistics" },
  ],
};

export function logFromStore(id: string, data: TravelLogStore): TravelLog {
  return {
    id,
    name: data.name,
    owners: data.owners,
    checklists: data.checklists || [DEFAULT_CHECKLIST],
    created: data.created.toDate(),
    updated: data.updated.toDate(),
  };
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
  checklistDone: Record<string, boolean>; // templateItemId → done, per trip
  created: Date;
  updated: Date;
}

export interface TripStore {
  destination: string;
  status: TripStatus;
  region: string;
  startDate: Timestamp | null;
  endDate: Timestamp | null;
  notes: string;
  sourceRefs: string;
  flaggedForReview: boolean;
  reviewComment: string;
  checklistDone?: Record<string, boolean>;
  created: Timestamp;
  updated: Timestamp;
}

export function tripFromStore(id: string, data: TripStore): Trip {
  return {
    id,
    destination: data.destination,
    status: data.status || "Idea",
    region: data.region || "",
    startDate: data.startDate?.toDate() ?? null,
    endDate: data.endDate?.toDate() ?? null,
    notes: data.notes || "",
    sourceRefs: data.sourceRefs || "",
    flaggedForReview: data.flaggedForReview || false,
    reviewComment: data.reviewComment || "",
    checklistDone: data.checklistDone || {},
    created: data.created.toDate(),
    updated: data.updated.toDate(),
  };
}

export function tripToStore(trip: Omit<Trip, "id">): TripStore {
  return {
    destination: trip.destination,
    status: trip.status,
    region: trip.region,
    startDate: trip.startDate ? Timestamp.fromDate(trip.startDate) : null,
    endDate: trip.endDate ? Timestamp.fromDate(trip.endDate) : null,
    notes: trip.notes,
    sourceRefs: trip.sourceRefs,
    flaggedForReview: trip.flaggedForReview,
    reviewComment: trip.reviewComment,
    checklistDone: Object.keys(trip.checklistDone).length > 0 ? trip.checklistDone : undefined,
    created: Timestamp.fromDate(trip.created),
    updated: Timestamp.fromDate(trip.updated),
  };
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

export interface ActivityStore {
  name: string;
  category: string;
  location: string;
  placeId?: string;
  lat?: number | null;
  lng?: number | null;
  description: string;
  costNotes: string;
  durationEstimate: string;
  confirmationCode?: string;
  details?: string;
  setting?: string;
  bookingReqs?: BookingRequirement[];
  rating?: number | null;
  ratingCount?: number | null;
  photoRef?: string;
  tripId: string;
  created: Timestamp;
  updated: Timestamp;
}

export function activityFromStore(id: string, data: ActivityStore): Activity {
  return {
    id,
    name: data.name,
    category: (data.category as ActivityCategory) || "Other",
    location: data.location || "",
    placeId: data.placeId || "",
    lat: data.lat ?? null,
    lng: data.lng ?? null,
    description: data.description || "",
    costNotes: data.costNotes || "",
    durationEstimate: data.durationEstimate || "",
    confirmationCode: data.confirmationCode || "",
    details: data.details || "",
    setting: (data.setting as Activity["setting"]) || "",
    bookingReqs: data.bookingReqs || [],
    rating: data.rating ?? null,
    ratingCount: data.ratingCount ?? null,
    photoRef: data.photoRef || "",
    tripId: data.tripId || "",
    created: data.created.toDate(),
    updated: data.updated.toDate(),
  };
}

export function activityToStore(activity: Omit<Activity, "id">): ActivityStore {
  return {
    name: activity.name,
    category: activity.category,
    location: activity.location,
    placeId: activity.placeId || undefined,
    lat: activity.lat,
    lng: activity.lng,
    description: activity.description,
    costNotes: activity.costNotes,
    durationEstimate: activity.durationEstimate,
    confirmationCode: activity.confirmationCode || undefined,
    details: activity.details || undefined,
    setting: activity.setting || undefined,
    bookingReqs: activity.bookingReqs.length > 0 ? activity.bookingReqs : undefined,
    rating: activity.rating ?? undefined,
    ratingCount: activity.ratingCount ?? undefined,
    photoRef: activity.photoRef || undefined,
    tripId: activity.tripId,
    created: Timestamp.fromDate(activity.created),
    updated: Timestamp.fromDate(activity.updated),
  };
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
  label: string; // "Day 2 — Sun Sep 8: Zion Narrows"
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

export interface ItineraryStore {
  tripId: string;
  name: string;
  isActive: boolean;
  days: ItineraryDay[];
  created: Timestamp;
  updated: Timestamp;
}

export function itineraryFromStore(id: string, data: ItineraryStore): Itinerary {
  return {
    id,
    tripId: data.tripId,
    name: data.name,
    isActive: data.isActive ?? true,
    days: data.days || [],
    created: data.created.toDate(),
    updated: data.updated.toDate(),
  };
}

export function itineraryToStore(itinerary: Omit<Itinerary, "id">): ItineraryStore {
  return {
    tripId: itinerary.tripId,
    name: itinerary.name,
    isActive: itinerary.isActive,
    days: itinerary.days,
    created: Timestamp.fromDate(itinerary.created),
    updated: Timestamp.fromDate(itinerary.updated),
  };
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
  // "2-3 hours" → average
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
