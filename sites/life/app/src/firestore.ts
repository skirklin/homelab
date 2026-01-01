import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  Timestamp,
  type UpdateData,
} from "firebase/firestore";
import { getBackend } from "@kirkl/shared";
import type { LogEntryStore, LifeLogStore, ActivityDef } from "./types";
import { DEFAULT_ACTIVITIES } from "./types";

const { db } = getBackend();

let currentLogId: string | null = null;

export function setCurrentLogId(logId: string | null) {
  currentLogId = logId;
}

export function getCurrentLogId(): string | null {
  return currentLogId;
}

// Collection references
function getEntriesRef(logId?: string) {
  const id = logId ?? currentLogId;
  if (!id) throw new Error("No log ID set");
  return collection(db, "lifeLogs", id, "entries");
}

function getEntryRef(entryId: string, logId?: string) {
  const id = logId ?? currentLogId;
  if (!id) throw new Error("No log ID set");
  return doc(db, "lifeLogs", id, "entries", entryId);
}

function getLogRef(logId?: string) {
  const id = logId ?? currentLogId;
  if (!id) throw new Error("No log ID set");
  return doc(db, "lifeLogs", id);
}

// Get or create the user's life log
export async function getOrCreateUserLog(userId: string): Promise<{ id: string; data: LifeLogStore }> {
  const userRef = doc(db, "users", userId);
  const userDoc = await getDoc(userRef);

  // Check if user already has a life log
  if (userDoc.exists() && userDoc.data()?.lifeLogId) {
    const logId = userDoc.data().lifeLogId;
    const logDoc = await getDoc(doc(db, "lifeLogs", logId));
    if (logDoc.exists()) {
      return { id: logId, data: logDoc.data() as LifeLogStore };
    }
  }

  // Create a new log for this user with default activities
  const logRef = doc(collection(db, "lifeLogs"));
  const logData: LifeLogStore = {
    name: "Life Log",
    owners: [userId],
    activities: DEFAULT_ACTIVITIES,
    created: Timestamp.now(),
    updated: Timestamp.now(),
  };
  await setDoc(logRef, logData);

  // Save the log ID to the user's profile
  if (userDoc.exists()) {
    await updateDoc(userRef, { lifeLogId: logRef.id });
  } else {
    await setDoc(userRef, { lifeLogId: logRef.id });
  }

  return { id: logRef.id, data: logData };
}

// Activity management
export async function updateActivities(activities: ActivityDef[], logId?: string): Promise<void> {
  const logRef = getLogRef(logId);
  await updateDoc(logRef, {
    activities,
    updated: Timestamp.now(),
  });
}

export async function addActivity(activity: ActivityDef, logId?: string): Promise<void> {
  const logRef = getLogRef(logId);
  const logDoc = await getDoc(logRef);
  if (!logDoc.exists()) return;

  const data = logDoc.data() as LifeLogStore;
  const activities = [...(data.activities ?? DEFAULT_ACTIVITIES), activity];
  await updateDoc(logRef, {
    activities,
    updated: Timestamp.now(),
  });
}

export async function removeActivity(activityId: string, logId?: string): Promise<void> {
  const logRef = getLogRef(logId);
  const logDoc = await getDoc(logRef);
  if (!logDoc.exists()) return;

  const data = logDoc.data() as LifeLogStore;
  const activities = (data.activities ?? DEFAULT_ACTIVITIES).filter(a => a.id !== activityId);
  await updateDoc(logRef, {
    activities,
    updated: Timestamp.now(),
  });
}

// Entry operations
export async function startActivity(
  activityId: string,
  userId: string,
  logId?: string
): Promise<string> {
  const entriesRef = getEntriesRef(logId);
  const entryData: LogEntryStore = {
    activityId,
    startTime: Timestamp.now(),
    endTime: null,
    duration: null,
    notes: "",
    createdBy: userId,
    createdAt: Timestamp.now(),
  };
  const docRef = await addDoc(entriesRef, entryData);
  return docRef.id;
}

export async function stopActivity(entryId: string, logId?: string): Promise<void> {
  const entryRef = getEntryRef(entryId, logId);
  const entryDoc = await getDoc(entryRef);

  if (!entryDoc.exists()) return;

  const data = entryDoc.data() as LogEntryStore;
  const endTime = Timestamp.now();
  const duration = Math.round((endTime.toMillis() - data.startTime.toMillis()) / 60000);

  await updateDoc(entryRef, { endTime, duration });
}

export async function addEntry(
  activityId: string,
  startTime: Date,
  endTime: Date | null,
  notes: string,
  userId: string,
  logId?: string
): Promise<string> {
  const entriesRef = getEntriesRef(logId);

  let duration: number | null = null;
  if (endTime) {
    duration = Math.round((endTime.getTime() - startTime.getTime()) / 60000);
  }

  const entryData: LogEntryStore = {
    activityId,
    startTime: Timestamp.fromDate(startTime),
    endTime: endTime ? Timestamp.fromDate(endTime) : null,
    duration,
    notes,
    createdBy: userId,
    createdAt: Timestamp.now(),
  };

  const docRef = await addDoc(entriesRef, entryData);
  return docRef.id;
}

export async function updateEntry(
  entryId: string,
  updates: Partial<{
    startTime: Date;
    endTime: Date | null;
    notes: string;
  }>,
  logId?: string
): Promise<void> {
  const entryRef = getEntryRef(entryId, logId);

  const updateData: UpdateData<LogEntryStore> = {};

  if (updates.startTime !== undefined) {
    updateData.startTime = Timestamp.fromDate(updates.startTime);
  }
  if (updates.endTime !== undefined) {
    updateData.endTime = updates.endTime ? Timestamp.fromDate(updates.endTime) : null;
  }
  if (updates.notes !== undefined) {
    updateData.notes = updates.notes;
  }

  // Recalculate duration if times changed
  if (updates.startTime !== undefined || updates.endTime !== undefined) {
    const entryDoc = await getDoc(entryRef);
    if (entryDoc.exists()) {
      const data = entryDoc.data() as LogEntryStore;
      const start = updates.startTime ?? data.startTime.toDate();
      const end = updates.endTime ?? data.endTime?.toDate();
      if (end) {
        updateData.duration = Math.round((end.getTime() - start.getTime()) / 60000);
      }
    }
  }

  await updateDoc(entryRef, updateData);
}

export async function deleteEntry(entryId: string, logId?: string): Promise<void> {
  const entryRef = getEntryRef(entryId, logId);
  await deleteDoc(entryRef);
}
