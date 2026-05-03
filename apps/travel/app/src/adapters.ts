/**
 * Adapters between @homelab/backend types and the travel app's local types.
 *
 * The backend uses simpler flat types (string dates, optional fields)
 * while the app uses richer types (Date objects, typed enums, etc.).
 */

import type {
  Trip as BackendTrip,
  Activity as BackendActivity,
  Itinerary as BackendItinerary,
  TravelLog as BackendTravelLog,
  ItineraryDay as BackendItineraryDay,
  DayEntry as BackendDayEntry,
} from "@homelab/backend";
import type {
  Trip,
  Activity,
  ActivityVerdict,
  Itinerary,
  TravelLog,
  TripStatus,
  ActivityCategory,
  DayEntry,
} from "./types";

// ==========================================
// Backend -> App conversions (for subscriptions)
// ==========================================

export function tripFromBackend(bt: BackendTrip): Trip {
  return {
    id: bt.id,
    destination: bt.destination || bt.name || "",
    status: (bt.status as TripStatus) || "Idea",
    region: bt.region || "",
    startDate: bt.startDate ? new Date(bt.startDate) : null,
    endDate: bt.endDate ? new Date(bt.endDate) : null,
    notes: bt.notes || "",
    sourceRefs: bt.sourceRefs || "",
    flaggedForReview: bt.flagged || false,
    reviewComment: bt.flagComment || "",
    created: new Date(bt.created),
    updated: new Date(bt.updated),
  };
}

export function activityFromBackend(ba: BackendActivity): Activity {
  return {
    id: ba.id,
    name: ba.name || "",
    category: (ba.category as ActivityCategory) || "Other",
    location: ba.location || "",
    placeId: ba.placeId || "",
    lat: ba.lat ?? null,
    lng: ba.lng ?? null,
    description: ba.description || "",
    costNotes: ba.costNotes || "",
    durationEstimate: ba.durationEstimate || "",
    walkMiles: ba.walkMiles ?? null,
    elevationGainFeet: ba.elevationGainFeet ?? null,
    difficulty: (ba.difficulty as Activity["difficulty"]) || "",
    confirmationCode: ba.confirmationCode || "",
    details: ba.details || "",
    setting: (ba.setting as Activity["setting"]) || "",
    bookingReqs: (ba.bookingReqs as Activity["bookingReqs"]) || [],
    rating: ba.rating ?? null,
    ratingCount: ba.ratingCount ?? null,
    photoRef: ba.photoRef || "",
    flightInfo: ba.flightInfo,
    verdict: (ba.verdict as ActivityVerdict | undefined) || undefined,
    personalNotes: ba.personalNotes || undefined,
    experiencedAt: ba.experiencedAt ? new Date(ba.experiencedAt) : undefined,
    tripId: ba.trip || "",
    created: new Date(ba.created),
    updated: new Date(ba.updated),
  };
}

export function dayEntryFromBackend(be: BackendDayEntry): DayEntry {
  return {
    id: be.id,
    tripId: be.trip,
    date: be.date,
    text: be.text || "",
    highlight: be.highlight || "",
    mood: be.mood ?? null,
    created: new Date(be.created),
    updated: new Date(be.updated),
  };
}

export function itineraryFromBackend(bi: BackendItinerary): Itinerary {
  return {
    id: bi.id,
    tripId: bi.trip || "",
    name: bi.name || "",
    isActive: bi.isActive ?? true,
    days: (bi.days || []).map((d) => ({
      date: d.date || undefined,
      label: d.label || "",
      lodgingActivityId: d.lodgingActivityId,
      flights: d.flights,
      slots: d.slots || [],
    })),
    created: new Date(bi.created),
    updated: new Date(bi.updated),
  };
}

export function logFromBackend(bl: BackendTravelLog): TravelLog {
  return {
    id: bl.id,
    name: bl.name || "",
    owners: bl.owners || [],
    created: new Date(bl.created),
    updated: new Date(bl.updated),
  };
}

// ==========================================
// App -> Backend conversions (for mutations)
// ==========================================

export function tripToBackend(trip: Omit<Trip, "id">): Omit<BackendTrip, "id" | "log" | "created" | "updated"> {
  return {
    name: trip.destination,
    destination: trip.destination,
    startDate: trip.startDate ? trip.startDate.toISOString() : "",
    endDate: trip.endDate ? trip.endDate.toISOString() : "",
    notes: trip.notes || "",
    flagged: trip.flaggedForReview || false,
    flagComment: trip.reviewComment || "",
    status: trip.status,
    region: trip.region,
    sourceRefs: trip.sourceRefs,
  };
}

export function tripUpdatesToBackend(fields: {
  destination?: string;
  status?: TripStatus;
  region?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  notes?: string;
  sourceRefs?: string;
  flaggedForReview?: boolean;
  reviewComment?: string;
}): Partial<Omit<BackendTrip, "id" | "log" | "created" | "updated">> {
  const updates: Record<string, unknown> = {};
  if (fields.destination !== undefined) {
    updates.name = fields.destination;
    updates.destination = fields.destination;
  }
  if (fields.status !== undefined) updates.status = fields.status;
  if (fields.region !== undefined) updates.region = fields.region;
  if (fields.startDate !== undefined) updates.startDate = fields.startDate ? fields.startDate.toISOString() : "";
  if (fields.endDate !== undefined) updates.endDate = fields.endDate ? fields.endDate.toISOString() : "";
  if (fields.notes !== undefined) updates.notes = fields.notes;
  if (fields.sourceRefs !== undefined) updates.sourceRefs = fields.sourceRefs;
  if (fields.flaggedForReview !== undefined) updates.flagged = fields.flaggedForReview;
  if (fields.reviewComment !== undefined) updates.flagComment = fields.reviewComment;
  return updates as Partial<Omit<BackendTrip, "id" | "log" | "created" | "updated">>;
}

export function activityToBackend(activity: Omit<Activity, "id">): Omit<BackendActivity, "id" | "log" | "created" | "updated"> {
  return {
    name: activity.name,
    location: activity.location,
    lat: activity.lat ?? undefined,
    lng: activity.lng ?? undefined,
    placeId: activity.placeId || undefined,
    description: activity.description || "",
    rating: activity.rating ?? undefined,
    tags: [],
    trip: activity.tripId,
    category: activity.category,
    costNotes: activity.costNotes,
    durationEstimate: activity.durationEstimate,
    walkMiles: activity.walkMiles ?? undefined,
    elevationGainFeet: activity.elevationGainFeet ?? undefined,
    difficulty: activity.difficulty || undefined,
    confirmationCode: activity.confirmationCode || "",
    details: activity.details || undefined,
    setting: activity.setting || undefined,
    bookingReqs: activity.bookingReqs?.length ? activity.bookingReqs : undefined,
    ratingCount: activity.ratingCount ?? undefined,
    photoRef: activity.photoRef || undefined,
    flightInfo: activity.flightInfo,
  };
}

export function activityUpdatesToBackend(fields: {
  name?: string;
  category?: ActivityCategory;
  location?: string;
  placeId?: string;
  lat?: number | null;
  lng?: number | null;
  description?: string;
  costNotes?: string;
  durationEstimate?: string;
  walkMiles?: number | null;
  elevationGainFeet?: number | null;
  difficulty?: string;
  confirmationCode?: string;
  details?: string;
  setting?: string;
  tripId?: string;
  flightInfo?: Activity["flightInfo"];
  verdict?: ActivityVerdict | null;
  personalNotes?: string;
  experiencedAt?: Date | null;
}): Partial<Omit<BackendActivity, "id" | "log" | "created" | "updated">> {
  const updates: Record<string, unknown> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.category !== undefined) updates.category = fields.category;
  if (fields.location !== undefined) updates.location = fields.location;
  if (fields.placeId !== undefined) updates.placeId = fields.placeId;
  if (fields.lat !== undefined) updates.lat = fields.lat;
  if (fields.lng !== undefined) updates.lng = fields.lng;
  if (fields.description !== undefined) updates.description = fields.description;
  if (fields.costNotes !== undefined) updates.costNotes = fields.costNotes;
  if (fields.durationEstimate !== undefined) updates.durationEstimate = fields.durationEstimate;
  if (fields.walkMiles !== undefined) updates.walkMiles = fields.walkMiles ?? undefined;
  if (fields.elevationGainFeet !== undefined) updates.elevationGainFeet = fields.elevationGainFeet ?? undefined;
  if (fields.difficulty !== undefined) updates.difficulty = fields.difficulty;
  if (fields.confirmationCode !== undefined) updates.confirmationCode = fields.confirmationCode;
  if (fields.details !== undefined) updates.details = fields.details;
  if (fields.setting !== undefined) updates.setting = fields.setting;
  if (fields.tripId !== undefined) updates.trip = fields.tripId;
  if (fields.flightInfo !== undefined) updates.flightInfo = fields.flightInfo;
  // Empty string clears the PB select field — null/empty both mean "no verdict".
  if (fields.verdict !== undefined) updates.verdict = fields.verdict ?? "";
  if (fields.personalNotes !== undefined) updates.personalNotes = fields.personalNotes;
  if (fields.experiencedAt !== undefined) {
    updates.experiencedAt = fields.experiencedAt ? fields.experiencedAt.toISOString() : "";
  }
  return updates as Partial<Omit<BackendActivity, "id" | "log" | "created" | "updated">>;
}

/**
 * Convert app ItineraryDay[] to backend ItineraryDay[].
 * Now that the backend type matches the actual data shape, this is a direct mapping.
 */
export function daysToBackend(days: import("./types").ItineraryDay[]): BackendItineraryDay[] {
  return days.map((d) => ({
    date: d.date,
    label: d.label,
    lodgingActivityId: d.lodgingActivityId,
    flights: d.flights,
    slots: d.slots,
  }));
}
