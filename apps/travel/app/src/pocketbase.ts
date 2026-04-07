/**
 * PocketBase data operations for the travel app.
 * Replaces the old firestore.ts.
 */
import { getBackend } from "@kirkl/shared";
import type {
  TripStatus,
  ActivityCategory,
  ChecklistTemplate,
  ItineraryDay,
} from "./types";
import { tripToStore, activityToStore, itineraryToStore } from "./types";
import type { Trip, Activity, Itinerary } from "./types";

// Current log ID - set by the router
let currentLogId = "";

export function setCurrentLogId(logId: string) {
  currentLogId = logId;
}

export function getCurrentLogId() {
  return currentLogId;
}

function pb() {
  return getBackend();
}

// ==========================================
// Travel Log CRUD
// ==========================================

export async function createLog(name: string, userId: string): Promise<string> {
  const log = await pb().collection("travel_logs").create({
    name,
    owners: [userId],
    checklists: [],
  });

  // Save slug to user profile
  await setUserSlug(userId, name.toLowerCase().replace(/\s+/g, "-"), log.id);
  return log.id;
}

export async function getOrCreateUserLog(userId: string): Promise<string> {
  try {
    const user = await pb().collection("users").getOne(userId);
    const slugs = user.travel_slugs as Record<string, string> | undefined;
    if (slugs) {
      const firstLogId = Object.values(slugs)[0];
      if (firstLogId) return firstLogId;
    }
  } catch {
    // User not found
  }

  return createLog("My Trips", userId);
}

// ==========================================
// Trip CRUD
// ==========================================

export async function addTrip(trip: Omit<Trip, "id">): Promise<string> {
  const data = tripToStore(trip, currentLogId);
  const record = await pb().collection("travel_trips").create(data);
  return record.id;
}

export async function updateTrip(tripId: string, updates: Record<string, unknown>) {
  await pb().collection("travel_trips").update(tripId, updates);
}

export async function deleteTrip(tripId: string) {
  await pb().collection("travel_trips").delete(tripId);
}

export async function flagTrip(tripId: string, flagged: boolean, comment: string = "") {
  await updateTrip(tripId, {
    flagged_for_review: flagged,
    review_comment: comment,
  });
}

// ==========================================
// Activity CRUD
// ==========================================

export async function addActivity(activity: Omit<Activity, "id">): Promise<string> {
  const data = activityToStore(activity, currentLogId);
  const record = await pb().collection("travel_activities").create(data);
  return record.id;
}

export async function updateActivity(activityId: string, updates: Record<string, unknown>) {
  await pb().collection("travel_activities").update(activityId, updates);
}

export async function deleteActivity(activityId: string) {
  await pb().collection("travel_activities").delete(activityId);
}

// ==========================================
// Itinerary CRUD
// ==========================================

export async function addItinerary(itinerary: Omit<Itinerary, "id">): Promise<string> {
  const data = itineraryToStore(itinerary, currentLogId);
  const record = await pb().collection("travel_itineraries").create(data);
  return record.id;
}

export async function updateItinerary(itineraryId: string, updates: Record<string, unknown>) {
  await pb().collection("travel_itineraries").update(itineraryId, updates);
}

export async function setItineraryDays(itineraryId: string, days: ItineraryDay[]) {
  await updateItinerary(itineraryId, { days });
}

export async function deleteItinerary(itineraryId: string) {
  await pb().collection("travel_itineraries").delete(itineraryId);
}

// ==========================================
// User profile (travel slugs)
// ==========================================

export async function getUserSlugs(userId: string, opts?: Record<string, unknown>): Promise<Record<string, string>> {
  try {
    const user = await pb().collection("users").getOne(userId, opts);
    return (user.travel_slugs as Record<string, string>) || {};
  } catch {
    return {};
  }
}

export async function setUserSlug(userId: string, slug: string, logId: string) {
  try {
    const user = await pb().collection("users").getOne(userId);
    const slugs = { ...((user.travel_slugs as Record<string, string>) || {}), [slug]: logId };
    await pb().collection("users").update(userId, { travel_slugs: slugs });
  } catch {
    // User may not exist yet
  }
}

// ==========================================
// Convenience: typed update helpers
// ==========================================

export function tripUpdates(fields: {
  destination?: string;
  status?: TripStatus;
  region?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  notes?: string;
  sourceRefs?: string;
  flaggedForReview?: boolean;
  reviewComment?: string;
}): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  if (fields.destination !== undefined) updates.destination = fields.destination;
  if (fields.status !== undefined) updates.status = fields.status;
  if (fields.region !== undefined) updates.region = fields.region;
  if (fields.startDate !== undefined)
    updates.start_date = fields.startDate ? fields.startDate.toISOString() : "";
  if (fields.endDate !== undefined)
    updates.end_date = fields.endDate ? fields.endDate.toISOString() : "";
  if (fields.notes !== undefined) updates.notes = fields.notes;
  if (fields.sourceRefs !== undefined) updates.source_refs = fields.sourceRefs;
  if (fields.flaggedForReview !== undefined) updates.flagged_for_review = fields.flaggedForReview;
  if (fields.reviewComment !== undefined) updates.review_comment = fields.reviewComment;
  return updates;
}

export function activityUpdates(fields: {
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
}): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.category !== undefined) updates.category = fields.category;
  if (fields.location !== undefined) updates.location = fields.location;
  if (fields.placeId !== undefined) updates.place_id = fields.placeId;
  if (fields.lat !== undefined) updates.lat = fields.lat;
  if (fields.lng !== undefined) updates.lng = fields.lng;
  if (fields.description !== undefined) updates.description = fields.description;
  if (fields.costNotes !== undefined) updates.cost_notes = fields.costNotes;
  if (fields.durationEstimate !== undefined) updates.duration_estimate = fields.durationEstimate;
  if (fields.confirmationCode !== undefined) updates.confirmation_code = fields.confirmationCode;
  if (fields.details !== undefined) updates.details = fields.details;
  if (fields.setting !== undefined) updates.setting = fields.setting;
  if (fields.tripId !== undefined) updates.trip_id = fields.tripId;
  return updates;
}

// ==========================================
// Checklist operations
// ==========================================

export async function toggleChecklistItem(tripId: string, itemId: string, done: boolean) {
  // Fetch current checklist_done, update the item, save back
  const trip = await pb().collection("travel_trips").getOne(tripId);
  const checklistDone = { ...((trip.checklist_done as Record<string, boolean>) || {}), [itemId]: done };
  await pb().collection("travel_trips").update(tripId, { checklist_done: checklistDone });
}

export async function updateLogChecklists(checklists: ChecklistTemplate[]) {
  await pb().collection("travel_logs").update(currentLogId, { checklists });
}
