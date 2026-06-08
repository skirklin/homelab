/**
 * Adapters between @homelab/backend types and the travel app's local types.
 *
 * The backend uses simpler flat types (string dates, optional fields)
 * while the app uses richer types (Date objects, typed enums, etc.).
 */

/**
 * Decode HTML entities in user-visible text. AI-generated activities have
 * occasionally landed with HTML-escaped strings (e.g. "Food &amp; Drink"),
 * either because the model thought it was writing into an HTML context or
 * because a source page already had the escapes. Decoding once at the adapter
 * means every consumer (lists, maps, exports) sees clean text without each
 * site having to remember to decode.
 *
 * Named entities cover the common cases; the numeric branch handles &#39;,
 * &#8211; etc. Anything unknown is left as-is.
 */
function decodeEntities(s: string): string {
  if (!s || s.indexOf("&") === -1) return s;
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
  };
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (m, dec, hex, name) => {
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return named[name] ?? m;
  });
}

import type {
  Trip as BackendTrip,
  Activity as BackendActivity,
  Itinerary as BackendItinerary,
  TravelLog as BackendTravelLog,
  ItineraryDay as BackendItineraryDay,
} from "@homelab/backend";
import { utcYmd, localYmd } from "./types";
import type {
  Trip,
  Activity,
  Itinerary,
  TravelLog,
  TripStatus,
  ActivityCategory,
} from "./types";

// ==========================================
// Backend -> App conversions (for subscriptions)
// ==========================================

/**
 * Trip start/end are stored in PB as a `date` (a full UTC instant) but are
 * semantically date-only. Reading them with `new Date(...)` and then local
 * getters shifts the day west of UTC — that's what made a Pacific user see a
 * trip as "day 2" the day before its start. Normalize at this boundary: take
 * the UTC date portion (the canonical reduction; mirrors the server's
 * `start_date.slice(0,10)`) and rebuild it as local midnight, so every
 * downstream consumer reads the correct date-only value via local getters.
 *
 * Symmetric with `tripDateToBackend` on the write side: a read-then-write of an
 * unchanged trip is identity (same calendar day) in every zone. Don't let one
 * boundary use the UTC-date reduction and the other `toISOString()` — that
 * asymmetry drifts the day east of UTC on every save.
 */
function tripDateFromBackend(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  // `utcYmd` is the canonical date-only reduction of a stored instant (mirrors
  // the server's `start_date.slice(0,10)`); rebuild it as local midnight so
  // every downstream consumer reads the right day via local getters.
  const [y, m, d] = utcYmd(parsed).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * The write counterpart to `tripDateFromBackend`. Trip dates are date-only, and
 * the local-midnight Date the read side produces must NOT be serialized with
 * `toISOString()`: east of UTC that rolls local-midnight back a calendar day
 * (e.g. 2026-06-02 midnight Sydney → 2026-06-01T14:00:00Z), corrupting the
 * stored date on every save. Reduce the local-midnight Date back to its
 * calendar day with `localYmd` (the inverse of the read side's local-midnight
 * rebuild) and persist it as a stable date-only UTC instant, so the round-trip
 * is identity in every zone — west AND east of UTC. The stored `…T00:00:00.000Z`
 * shape keeps the canonical rule "the UTC date portion IS the trip date" intact
 * (mirrors the server gate's `start_date.slice(0,10)`).
 */
function tripDateToBackend(date: Date | null | undefined): string {
  if (!date) return "";
  return `${localYmd(date)}T00:00:00.000Z`;
}

export function tripFromBackend(bt: BackendTrip): Trip {
  return {
    id: bt.id,
    destination: decodeEntities(bt.destination || bt.name || ""),
    status: (bt.status as TripStatus) || "Idea",
    region: decodeEntities(bt.region || ""),
    startDate: tripDateFromBackend(bt.startDate),
    endDate: tripDateFromBackend(bt.endDate),
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
    name: decodeEntities(ba.name || ""),
    category: (decodeEntities(ba.category || "") as ActivityCategory) || "Other",
    location: decodeEntities(ba.location || ""),
    placeId: ba.placeId || "",
    lat: ba.lat ?? null,
    lng: ba.lng ?? null,
    description: decodeEntities(ba.description || ""),
    costNotes: decodeEntities(ba.costNotes || ""),
    durationEstimate: ba.durationEstimate || "",
    walkMiles: ba.walkMiles ?? null,
    elevationGainFeet: ba.elevationGainFeet ?? null,
    difficulty: (ba.difficulty as Activity["difficulty"]) || "",
    confirmationCode: ba.confirmationCode || "",
    details: decodeEntities(ba.details || ""),
    setting: (ba.setting as Activity["setting"]) || "",
    rating: ba.rating ?? null,
    ratingCount: ba.ratingCount ?? null,
    photoRef: ba.photoRef || "",
    flightInfo: ba.flightInfo,
    experiencedAt: ba.experiencedAt ? new Date(ba.experiencedAt) : undefined,
    tripId: ba.trip || "",
    created: new Date(ba.created),
    updated: new Date(ba.updated),
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
    startDate: tripDateToBackend(trip.startDate),
    endDate: tripDateToBackend(trip.endDate),
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
  if (fields.startDate !== undefined) updates.startDate = tripDateToBackend(fields.startDate);
  if (fields.endDate !== undefined) updates.endDate = tripDateToBackend(fields.endDate);
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
