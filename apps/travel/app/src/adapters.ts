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
    status: ((bt as Record<string, unknown>).status as TripStatus) || "Idea",
    region: ((bt as Record<string, unknown>).region as string) || "",
    startDate: bt.startDate ? new Date(bt.startDate) : null,
    endDate: bt.endDate ? new Date(bt.endDate) : null,
    notes: bt.notes || "",
    sourceRefs: ((bt as Record<string, unknown>).source_refs as string) || ((bt as Record<string, unknown>).sourceRefs as string) || "",
    flaggedForReview: bt.flagged || false,
    reviewComment: bt.flagComment || "",
    checklistDone: bt.checklistDone || {},
    created: new Date(((bt as Record<string, unknown>).created as string) || Date.now()),
    updated: new Date(((bt as Record<string, unknown>).updated as string) || Date.now()),
  };
}

export function activityFromBackend(ba: BackendActivity): Activity {
  const raw = ba as Record<string, unknown>;
  return {
    id: ba.id,
    name: ba.name || "",
    category: ((raw.category as ActivityCategory) || "Other"),
    location: ba.location || "",
    placeId: ba.placeId || "",
    lat: ba.lat ?? null,
    lng: ba.lng ?? null,
    description: (raw.description as string) || "",
    costNotes: (raw.cost_notes as string) || (raw.costNotes as string) || "",
    durationEstimate: (raw.duration_estimate as string) || (raw.durationEstimate as string) || "",
    confirmationCode: (raw.confirmation_code as string) || (raw.confirmationCode as string) || "",
    details: (raw.details as string) || "",
    setting: ((raw.setting as Activity["setting"]) || ""),
    bookingReqs: (raw.booking_reqs as Activity["bookingReqs"]) || (raw.bookingReqs as Activity["bookingReqs"]) || [],
    rating: (ba.rating as number) ?? null,
    ratingCount: (raw.rating_count as number) ?? (raw.ratingCount as number) ?? null,
    photoRef: (raw.photo_ref as string) || (raw.photoRef as string) || "",
    tripId: (ba.trip as string) || (raw.trip_id as string) || "",
    created: new Date((raw.created as string) || Date.now()),
    updated: new Date((raw.updated as string) || Date.now()),
  };
}

export function itineraryFromBackend(bi: BackendItinerary): Itinerary {
  const raw = bi as unknown as Record<string, unknown>;
  return {
    id: bi.id,
    tripId: bi.trip || (raw.trip_id as string) || "",
    name: bi.name || "",
    isActive: (raw.is_active as boolean) ?? (raw.isActive as boolean) ?? true,
    days: (bi.days || []).map((d) => {
      const dr = d as unknown as Record<string, unknown>;
      return {
        date: d.date || undefined,
        label: (dr.label as string) || "",
        lodgingActivityId: dr.lodgingActivityId as string | undefined,
        flights: dr.flights as Itinerary["days"][0]["flights"],
        slots: (dr.slots as Itinerary["days"][0]["slots"]) || [],
      };
    }),
    created: new Date((raw.created as string) || Date.now()),
    updated: new Date((raw.updated as string) || Date.now()),
  };
}

export function logFromBackend(bl: BackendTravelLog): TravelLog {
  const raw = bl as unknown as Record<string, unknown>;
  return {
    id: bl.id,
    name: bl.name || "",
    owners: bl.owners || [],
    checklists: bl.checklists?.length ? bl.checklists.map((c) => ({
      id: c.id,
      name: c.name,
      items: c.items.map((i) => {
        const ir = i as unknown as Record<string, unknown>;
        return {
          id: i.id,
          text: i.text,
          category: (ir.category as string) || "",
        };
      }),
    })) : [DEFAULT_CHECKLIST],
    created: new Date((raw.created as string) || Date.now()),
    updated: new Date((raw.updated as string) || Date.now()),
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
  } as Omit<BackendTrip, "id" | "log">;
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
    cost_notes: activity.costNotes,
    duration_estimate: activity.durationEstimate,
    confirmation_code: activity.confirmationCode || undefined,
    details: activity.details || undefined,
    setting: activity.setting || undefined,
    booking_reqs: activity.bookingReqs?.length ? activity.bookingReqs : undefined,
    rating_count: activity.ratingCount ?? undefined,
    photo_ref: activity.photoRef || undefined,
  } as Omit<BackendActivity, "id" | "log">;
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
 * The app stores extra fields (label, slots, flights, lodgingActivityId) which
 * pass through via the backend's JSON column. We cast through unknown since
 * the backend type is narrower than what PocketBase actually stores.
 */
export function daysToBackend(days: import("./types").ItineraryDay[]): BackendItineraryDay[] {
  return days as unknown as BackendItineraryDay[];
}
