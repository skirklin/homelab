/**
 * PocketBase data operations for the life tracker app.
 * Replaces the old firestore.ts.
 */
import { getBackend, type EventStore } from "@kirkl/shared";
import type { LifeLogStore, LifeManifest } from "./types";
import { DEFAULT_MANIFEST } from "./types";

const LOG_ID_CACHE_KEY = "life-log-id";

let currentLogId: string | null = null;

function pb() {
  return getBackend();
}

export function setCurrentLogId(logId: string | null) {
  currentLogId = logId;
  if (logId) {
    localStorage.setItem(LOG_ID_CACHE_KEY, logId);
  }
}

export function getCurrentLogId(): string | null {
  return currentLogId;
}

/** Get cached log ID for optimistic loading */
export function getCachedLogId(): string | null {
  return localStorage.getItem(LOG_ID_CACHE_KEY);
}

function requireLogId(logId?: string): string {
  const id = logId ?? currentLogId;
  if (!id) throw new Error("No log ID set");
  return id;
}

export async function getOrCreateUserLog(userId: string): Promise<{ id: string; data: LifeLogStore }> {
  // Disable auto-cancellation for initialization requests — React re-renders
  // can trigger this effect multiple times, and PB's auto-cancel would abort
  // the first request, leaving the app stuck on a spinner.
  const opts = { $autoCancel: false };

  // Check if user has a life_log_id
  const user = await pb().collection("users").getOne(userId, opts);

  if (user.life_log_id) {
    try {
      const log = await pb().collection("life_logs").getOne(user.life_log_id, opts);
      return {
        id: log.id,
        data: {
          name: log.name,
          owners: log.owners,
          manifest: log.manifest,
          sampleSchedule: log.sample_schedule,
          created: log.created,
          updated: log.updated,
        },
      };
    } catch {
      // Log doesn't exist, fall through to create
    }
  }

  // Create a new log
  const log = await pb().collection("life_logs").create({
    name: "Life Log",
    owners: [userId],
    manifest: DEFAULT_MANIFEST,
  }, opts);

  // Save the log ID on the user record
  await pb().collection("users").update(userId, { life_log_id: log.id }, opts);

  return {
    id: log.id,
    data: {
      name: log.name,
      owners: log.owners,
      manifest: log.manifest ?? DEFAULT_MANIFEST,
      sampleSchedule: log.sample_schedule,
      created: log.created,
      updated: log.updated,
    },
  };
}

// Manifest Operations

export async function updateManifest(manifest: LifeManifest, logId?: string): Promise<void> {
  const id = requireLogId(logId);
  await pb().collection("life_logs").update(id, { manifest });
}

export async function clearSampleSchedule(logId?: string): Promise<void> {
  const id = requireLogId(logId);
  await pb().collection("life_logs").update(id, { sample_schedule: null });
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
  const id = requireLogId(options?.logId);

  // Build event data - notes and source go inside data field
  const eventData: Record<string, unknown> = { ...data };
  if (options?.source) {
    eventData.source = options.source;
  }
  if (options?.notes) {
    eventData.notes = options.notes;
  }

  const eventStore: EventStore = {
    subject_id: widgetId,
    timestamp: (options?.timestamp ?? new Date()).toISOString(),
    created_by: userId,
    data: eventData,
  };

  const record = await pb().collection("life_events").create({
    log: id,
    ...eventStore,
  });
  return record.id;
}

export async function updateEntry(
  eventId: string,
  updates: Partial<{
    timestamp: Date;
    data: Record<string, unknown>;
    notes: string;
  }>,
  _logId?: string
): Promise<void> {
  const updateData: Record<string, unknown> = {};

  if (updates.timestamp !== undefined) {
    updateData.timestamp = updates.timestamp.toISOString();
  }
  if (updates.data !== undefined) {
    const newData = { ...updates.data };
    if (updates.notes !== undefined) {
      newData.notes = updates.notes;
    }
    updateData.data = newData;
  } else if (updates.notes !== undefined) {
    // Need to merge notes into existing data
    const existing = await pb().collection("life_events").getOne(eventId);
    updateData.data = { ...(existing.data || {}), notes: updates.notes };
  }

  await pb().collection("life_events").update(eventId, updateData);
}

export async function deleteEntry(eventId: string, _logId?: string): Promise<void> {
  await pb().collection("life_events").delete(eventId);
}

// Sample Response

export async function addSampleResponse(
  responses: Record<string, unknown>,
  userId: string,
  logId?: string
): Promise<string> {
  const id = requireLogId(logId);

  const eventStore: EventStore = {
    subject_id: "__sample__",
    timestamp: new Date().toISOString(),
    created_by: userId,
    data: { ...responses, source: "sample" },
  };

  const record = await pb().collection("life_events").create({
    log: id,
    ...eventStore,
  });
  return record.id;
}

// FCM Token Management

export async function saveFcmToken(userId: string, token: string): Promise<void> {
  const user = await pb().collection("users").getOne(userId);
  const tokens: string[] = user.fcm_tokens || [];
  if (!tokens.includes(token)) {
    tokens.push(token);
    await pb().collection("users").update(userId, { fcm_tokens: tokens });
  }
}

export async function removeFcmToken(userId: string, token?: string): Promise<void> {
  if (!token) return;
  const user = await pb().collection("users").getOne(userId);
  const tokens: string[] = (user.fcm_tokens || []).filter((t: string) => t !== token);
  await pb().collection("users").update(userId, { fcm_tokens: tokens });
}

export async function getFcmTokens(userId: string): Promise<string[]> {
  const user = await pb().collection("users").getOne(userId);
  return (user.fcm_tokens as string[]) || [];
}

export async function clearAllFcmTokens(userId: string): Promise<void> {
  await pb().collection("users").update(userId, { fcm_tokens: [] });
}
