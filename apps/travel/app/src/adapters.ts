/**
 * Adapters between @homelab/backend types and the travel app's local types.
 *
 * The backend uses simpler flat types (string dates, [key: string]: unknown)
 * while the app uses richer types (Date objects, typed enums, etc.).
 */

import type {
  Trip as BackendTrip,
  Activity as BackendActivity,
  Itinerary as BackendItinerary,
  TravelLog as BackendTravelLog,
  ItineraryDay as BackendItineraryDay,
} from "@homelab/backend";
import type {
  Trip,
  Activity,
  Itinerary,
  TravelLog,
  TripStatus,
  ActivityCategory,
} from "./types";
import { DEFAULT_CHECKLIST } from "./types";

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
    sourceRefs: bt.source_refs || "",
    flaggedForReview: bt.flagged || false,
    reviewComment: bt.flagComment || "",
    checklistDone: bt.checklistDone || {},
    created: new Date((bt.created as string) || Date.now()),
    updated: new Date((bt.updated as string) || Date.now()),
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
    description: (ba.notes as string) || "",
    costNotes: ba.costNotes || (ba.cost_notes as string) || "",
    durationEstimate: ba.durationEstimate || (ba.duration_estimate as string) || "",
    confirmationCode: ba.confirmationCode || (ba.confirmation_code as string) || "",
    details: (ba.details as string) || "",
    setting: ((ba.setting as Activity["setting"]) || ""),
    bookingReqs: (ba.booking_reqs as Activity["bookingReqs"]) || (ba.bookingReqs as Activity["bookingReqs"]) || [],
    rating: (ba.rating as number) ?? null,
    ratingCount: (ba.rating_count as number) ?? (ba.ratingCount as number) ?? null,
    photoRef: (ba.photo_ref as string) || (ba.photoRef as string) || "",
    tripId: (ba.trip as string) || (ba.trip_id as string) || "",
    created: new Date((ba.created as string) || Date.now()),
    updated: new Date((ba.updated as string) || Date.now()),
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
    created: new Date((bi.created as string) || Date.now()),
    updated: new Date((bi.updated as string) || Date.now()),
  };
}

export function logFromBackend(bl: BackendTravelLog): TravelLog {
  return {
    id: bl.id,
    name: bl.name || "",
    owners: bl.owners || [],
    checklists: bl.checklists?.length ? bl.checklists.map((c) => ({
      id: c.id,
      name: c.name,
      items: c.items.map((i) => ({
        id: i.id,
        text: i.text,
        category: i.category || "",
      })),
    })) : [DEFAULT_CHECKLIST],
    created: new Date((bl.created as string) || Date.now()),
    updated: new Date((bl.updated as string) || Date.now()),
  };
}

// ==========================================
// App -> Backend conversions (for mutations)
// ==========================================

export function tripToBackend(trip: Omit<Trip, "id">): Omit<BackendTrip, "id" | "log"> {
  return {
    name: trip.destination,
    destination: trip.destination,
    startDate: trip.startDate ? trip.startDate.toISOString() : "",
    endDate: trip.endDate ? trip.endDate.toISOString() : "",
    notes: trip.notes || "",
    flagged: trip.flaggedForReview || false,
    flagComment: trip.reviewComment || "",
    checklistDone: trip.checklistDone || {},
    status: trip.status,
    region: trip.region,
    source_refs: trip.sourceRefs,
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
}): Partial<Omit<BackendTrip, "id" | "log">> {
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
  if (fields.sourceRefs !== undefined) updates.source_refs = fields.sourceRefs;
  if (fields.flaggedForReview !== undefined) updates.flagged = fields.flaggedForReview;
  if (fields.reviewComment !== undefined) updates.flagComment = fields.reviewComment;
  return updates as Partial<Omit<BackendTrip, "id" | "log">>;
}

export function activityToBackend(activity: Omit<Activity, "id">): Omit<BackendActivity, "id" | "log"> {
  return {
    name: activity.name,
    location: activity.location,
    lat: activity.lat ?? undefined,
    lng: activity.lng ?? undefined,
    placeId: activity.placeId || undefined,
    notes: activity.description || "",
    rating: activity.rating ?? undefined,
    tags: [],
    trip: activity.tripId,
    category: activity.category,
    costNotes: activity.costNotes,
    durationEstimate: activity.durationEstimate,
    confirmationCode: activity.confirmationCode || "",
    // Snake_case aliases for PocketBase column mapping
    cost_notes: activity.costNotes,
    duration_estimate: activity.durationEstimate,
    confirmation_code: activity.confirmationCode || undefined,
    details: activity.details || undefined,
    setting: activity.setting || undefined,
    booking_reqs: activity.bookingReqs?.length ? activity.bookingReqs : undefined,
    rating_count: activity.ratingCount ?? undefined,
    photo_ref: activity.photoRef || undefined,
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
  confirmationCode?: string;
  details?: string;
  setting?: string;
  tripId?: string;
}): Partial<Omit<BackendActivity, "id" | "log">> {
  const updates: Record<string, unknown> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.category !== undefined) updates.category = fields.category;
  if (fields.location !== undefined) updates.location = fields.location;
  if (fields.placeId !== undefined) updates.placeId = fields.placeId;
  if (fields.lat !== undefined) updates.lat = fields.lat;
  if (fields.lng !== undefined) updates.lng = fields.lng;
  if (fields.description !== undefined) updates.notes = fields.description;
  if (fields.costNotes !== undefined) updates.cost_notes = fields.costNotes;
  if (fields.durationEstimate !== undefined) updates.duration_estimate = fields.durationEstimate;
  if (fields.confirmationCode !== undefined) updates.confirmation_code = fields.confirmationCode;
  if (fields.details !== undefined) updates.details = fields.details;
  if (fields.setting !== undefined) updates.setting = fields.setting;
  if (fields.tripId !== undefined) updates.trip = fields.tripId;
  return updates as Partial<Omit<BackendActivity, "id" | "log">>;
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
