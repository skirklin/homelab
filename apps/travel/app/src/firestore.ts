import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  Timestamp,
  getDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "./backend";
import type {
  TripStore,
  ActivityStore,
  ItineraryStore,
  ItineraryDay,
  UserProfileStore,
  TripStatus,
  ActivityCategory,
  ChecklistTemplate,
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

// Collection references
export function getLogRef(logId?: string) {
  return doc(db, "travelLogs", logId || currentLogId);
}

export function getTripsRef(logId?: string) {
  return collection(db, "travelLogs", logId || currentLogId, "trips");
}

export function getTripRef(tripId: string, logId?: string) {
  return doc(db, "travelLogs", logId || currentLogId, "trips", tripId);
}

export function getActivitiesRef(logId?: string) {
  return collection(db, "travelLogs", logId || currentLogId, "activities");
}

export function getActivityRef(activityId: string, logId?: string) {
  return doc(db, "travelLogs", logId || currentLogId, "activities", activityId);
}

export function getItinerariesRef(logId?: string) {
  return collection(db, "travelLogs", logId || currentLogId, "itineraries");
}

export function getItineraryRef(itineraryId: string, logId?: string) {
  return doc(db, "travelLogs", logId || currentLogId, "itineraries", itineraryId);
}

export function getUserRef(userId: string) {
  return doc(db, "users", userId);
}

// ==========================================
// Travel Log CRUD
// ==========================================

export async function createLog(name: string, userId: string): Promise<string> {
  const logsRef = collection(db, "travelLogs");
  const newLogRef = doc(logsRef);
  await setDoc(newLogRef, {
    name,
    owners: [userId],
    created: Timestamp.now(),
    updated: Timestamp.now(),
  });

  // Save slug to user profile
  await setUserSlug(userId, name.toLowerCase().replace(/\s+/g, "-"), newLogRef.id);
  return newLogRef.id;
}

export async function getOrCreateUserLog(userId: string): Promise<string> {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    const slugs = (data as Record<string, unknown>).travelSlugs as Record<string, string> | undefined;
    if (slugs) {
      const firstSlug = Object.values(slugs)[0];
      if (firstSlug) return firstSlug;
    }
  }

  return createLog("My Trips", userId);
}

// ==========================================
// Trip CRUD
// ==========================================

export async function addTrip(trip: Omit<Trip, "id">): Promise<string> {
  const tripRef = doc(getTripsRef());
  const tripData = tripToStore(trip);
  await setDoc(tripRef, tripData);
  return tripRef.id;
}

export async function updateTrip(tripId: string, updates: Partial<TripStore>) {
  const tripRef = getTripRef(tripId);
  await updateDoc(tripRef, { ...updates, updated: Timestamp.now() });
}

export async function deleteTrip(tripId: string) {
  const tripRef = getTripRef(tripId);
  await deleteDoc(tripRef);
}

export async function flagTrip(tripId: string, flagged: boolean, comment: string = "") {
  await updateTrip(tripId, {
    flaggedForReview: flagged,
    reviewComment: comment,
  });
}

// ==========================================
// Activity CRUD
// ==========================================

export async function addActivity(activity: Omit<Activity, "id">): Promise<string> {
  const activityRef = doc(getActivitiesRef());
  const activityData = activityToStore(activity);
  await setDoc(activityRef, activityData);
  return activityRef.id;
}

export async function updateActivity(activityId: string, updates: Partial<ActivityStore>) {
  const activityRef = getActivityRef(activityId);
  await updateDoc(activityRef, { ...updates, updated: Timestamp.now() });
}

export async function deleteActivity(activityId: string) {
  const activityRef = getActivityRef(activityId);
  await deleteDoc(activityRef);
}

// ==========================================
// Itinerary CRUD
// ==========================================

export async function addItinerary(itinerary: Omit<Itinerary, "id">): Promise<string> {
  const itineraryRef = doc(getItinerariesRef());
  const itineraryData = itineraryToStore(itinerary);
  await setDoc(itineraryRef, itineraryData);
  return itineraryRef.id;
}

export async function updateItinerary(itineraryId: string, updates: Partial<ItineraryStore>) {
  const itineraryRef = getItineraryRef(itineraryId);
  await updateDoc(itineraryRef, { ...updates, updated: Timestamp.now() });
}

export async function setItineraryDays(itineraryId: string, days: ItineraryDay[]) {
  await updateItinerary(itineraryId, { days });
}

export async function deleteItinerary(itineraryId: string) {
  const itineraryRef = getItineraryRef(itineraryId);
  await deleteDoc(itineraryRef);
}

// ==========================================
// User profile (travel slugs)
// ==========================================

export async function getUserSlugs(userId: string): Promise<Record<string, string>> {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) {
    const data = userSnap.data() as Record<string, unknown>;
    return (data.travelSlugs as Record<string, string>) || {};
  }
  return {};
}

export async function setUserSlug(userId: string, slug: string, logId: string) {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    const data = userSnap.data() as Record<string, unknown>;
    const travelSlugs = { ...(data.travelSlugs as Record<string, string>), [slug]: logId };
    await updateDoc(userRef, { travelSlugs });
  } else {
    await setDoc(userRef, { travelSlugs: { [slug]: logId } });
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
}): Partial<TripStore> {
  const updates: Partial<TripStore> = {};
  if (fields.destination !== undefined) updates.destination = fields.destination;
  if (fields.status !== undefined) updates.status = fields.status;
  if (fields.region !== undefined) updates.region = fields.region;
  if (fields.startDate !== undefined)
    updates.startDate = fields.startDate ? Timestamp.fromDate(fields.startDate) : null;
  if (fields.endDate !== undefined)
    updates.endDate = fields.endDate ? Timestamp.fromDate(fields.endDate) : null;
  if (fields.notes !== undefined) updates.notes = fields.notes;
  if (fields.sourceRefs !== undefined) updates.sourceRefs = fields.sourceRefs;
  if (fields.flaggedForReview !== undefined) updates.flaggedForReview = fields.flaggedForReview;
  if (fields.reviewComment !== undefined) updates.reviewComment = fields.reviewComment;
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
}): Partial<ActivityStore> {
  const updates: Partial<ActivityStore> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.category !== undefined) updates.category = fields.category;
  if (fields.location !== undefined) updates.location = fields.location;
  if (fields.placeId !== undefined) updates.placeId = fields.placeId;
  if (fields.lat !== undefined) updates.lat = fields.lat;
  if (fields.lng !== undefined) updates.lng = fields.lng;
  if (fields.description !== undefined) updates.description = fields.description;
  if (fields.costNotes !== undefined) updates.costNotes = fields.costNotes;
  if (fields.durationEstimate !== undefined) updates.durationEstimate = fields.durationEstimate;
  if (fields.confirmationCode !== undefined) updates.confirmationCode = fields.confirmationCode;
  if (fields.details !== undefined) updates.details = fields.details;
  if (fields.setting !== undefined) updates.setting = fields.setting;
  if (fields.tripId !== undefined) updates.tripId = fields.tripId;
  return updates;
}

// ==========================================
// Checklist operations
// ==========================================

export async function toggleChecklistItem(tripId: string, itemId: string, done: boolean) {
  const tripRef = getTripRef(tripId);
  await updateDoc(tripRef, {
    [`checklistDone.${itemId}`]: done,
    updated: Timestamp.now(),
  });
}

export async function updateLogChecklists(checklists: ChecklistTemplate[]) {
  const logRef = getLogRef();
  await updateDoc(logRef, { checklists, updated: Timestamp.now() });
}
