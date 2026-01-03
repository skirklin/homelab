import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  Timestamp,
} from "firebase/firestore";
import { getBackend, type EventStore } from "@kirkl/shared";
import type { LifeLogStore, LifeManifest } from "./types";
import { DEFAULT_MANIFEST } from "./types";

const { db } = getBackend();

let currentLogId: string | null = null;

export function setCurrentLogId(logId: string | null) {
  currentLogId = logId;
}

export function getCurrentLogId(): string | null {
  return currentLogId;
}

function getEventsRef(logId?: string) {
  const id = logId ?? currentLogId;
  if (!id) throw new Error("No log ID set");
  return collection(db, "lifeLogs", id, "events");
}

function getEventRef(eventId: string, logId?: string) {
  const id = logId ?? currentLogId;
  if (!id) throw new Error("No log ID set");
  return doc(db, "lifeLogs", id, "events", eventId);
}

function getLogRef(logId?: string) {
  const id = logId ?? currentLogId;
  if (!id) throw new Error("No log ID set");
  return doc(db, "lifeLogs", id);
}

export async function getOrCreateUserLog(userId: string): Promise<{ id: string; data: LifeLogStore }> {
  const userRef = doc(db, "users", userId);
  const userDoc = await getDoc(userRef);

  if (userDoc.exists() && userDoc.data()?.lifeLogId) {
    const logId = userDoc.data().lifeLogId;
    const logDoc = await getDoc(doc(db, "lifeLogs", logId));
    if (logDoc.exists()) {
      return { id: logId, data: logDoc.data() as LifeLogStore };
    }
  }

  const logRef = doc(collection(db, "lifeLogs"));
  const logData: LifeLogStore = {
    name: "Life Log",
    owners: [userId],
    manifest: DEFAULT_MANIFEST,
    created: Timestamp.now(),
    updated: Timestamp.now(),
  };
  await setDoc(logRef, logData);

  if (userDoc.exists()) {
    await updateDoc(userRef, { lifeLogId: logRef.id });
  } else {
    await setDoc(userRef, { lifeLogId: logRef.id });
  }

  return { id: logRef.id, data: logData };
}

// Manifest Operations

export async function updateManifest(manifest: LifeManifest, logId?: string): Promise<void> {
  const logRef = getLogRef(logId);
  await updateDoc(logRef, {
    manifest,
    updated: Timestamp.now(),
  });
}

// Event Operations

export async function addEntry(
  widgetId: string,
  data: Record<string, unknown>,
  userId: string,
  options?: {
    timestamp?: Date;
    notes?: string;
    source?: "manual" | "sample";
    logId?: string;
  }
): Promise<string> {
  const eventsRef = getEventsRef(options?.logId);

  // Build event data - notes and source go inside data field
  const eventData: Record<string, unknown> = { ...data };
  if (options?.source) {
    eventData.source = options.source;
  }
  if (options?.notes) {
    eventData.notes = options.notes;
  }

  const eventStore: EventStore = {
    subjectId: widgetId,
    timestamp: options?.timestamp ? Timestamp.fromDate(options.timestamp) : Timestamp.now(),
    data: eventData,
    createdBy: userId,
    createdAt: Timestamp.now(),
  };

  const docRef = await addDoc(eventsRef, eventStore);
  return docRef.id;
}

export async function updateEntry(
  eventId: string,
  updates: Partial<{
    timestamp: Date;
    data: Record<string, unknown>;
    notes: string;
  }>,
  logId?: string
): Promise<void> {
  const eventRef = getEventRef(eventId, logId);

  const updateData: Record<string, unknown> = {};

  if (updates.timestamp !== undefined) {
    updateData.timestamp = Timestamp.fromDate(updates.timestamp);
  }
  if (updates.data !== undefined) {
    // Merge notes into data if updating data
    const newData = { ...updates.data };
    if (updates.notes !== undefined) {
      newData.notes = updates.notes;
    }
    updateData.data = newData;
  } else if (updates.notes !== undefined) {
    // Only updating notes - need to update data.notes
    updateData["data.notes"] = updates.notes;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await updateDoc(eventRef, updateData as any);
}

export async function deleteEntry(eventId: string, logId?: string): Promise<void> {
  const eventRef = getEventRef(eventId, logId);
  await deleteDoc(eventRef);
}

// Sample Response

export async function addSampleResponse(
  responses: Record<string, unknown>,
  userId: string,
  logId?: string
): Promise<string> {
  const eventsRef = getEventsRef(logId);

  const eventStore: EventStore = {
    subjectId: "__sample__",
    timestamp: Timestamp.now(),
    data: { ...responses, source: "sample" },
    createdBy: userId,
    createdAt: Timestamp.now(),
  };

  const docRef = await addDoc(eventsRef, eventStore);
  return docRef.id;
}

// FCM Token Management

export async function saveFcmToken(userId: string, token: string): Promise<void> {
  const userRef = doc(db, "users", userId);
  // Use merge to handle both create and update without reading first
  await setDoc(userRef, { fcmToken: token }, { merge: true });
}

export async function removeFcmToken(userId: string): Promise<void> {
  const userRef = doc(db, "users", userId);
  await updateDoc(userRef, { fcmToken: null });
}
