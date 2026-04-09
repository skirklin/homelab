/**
 * @deprecated Use `@homelab/backend` via backend-provider.tsx instead.
 * This file is kept for backward compatibility with e2e tests.
 *
 * PocketBase data operations for the upkeep app.
 * Replaces the old firestore.ts.
 */
import { getBackend } from "@kirkl/shared";
import type { Task, RoomDef } from "./types";

// Current list ID - set by the router
let currentListId = "default";

export function setCurrentListId(listId: string) {
  currentListId = listId;
}

export function getCurrentListId() {
  return currentListId;
}

function pb() {
  return getBackend();
}

// ===== List operations =====

export async function ensureListExists(userId: string) {
  const opts = { $autoCancel: false };
  try {
    const list = await pb().collection("task_lists").getOne(currentListId, opts);
    if (!list.owners.includes(userId)) {
      await pb().collection("task_lists").update(currentListId, {
        owners: [...(Array.isArray(list.owners) ? list.owners : [list.owners]), userId],
      }, opts);
    }
  } catch {
    // List doesn't exist — don't auto-create
  }
}

export async function createList(name: string, slug: string, userId: string): Promise<string> {
  const opts = { $autoCancel: false };
  const list = await pb().collection("task_lists").create({
    name,
    owners: [userId],
    room_defs: [],
  }, opts);

  await setUserSlug(userId, slug, list.id, opts);
  return list.id;
}

export async function renameList(listId: string, newName: string) {
  await pb().collection("task_lists").update(listId, { name: newName });
}

export async function deleteList(listId: string) {
  await pb().collection("task_lists").delete(listId);
}

export async function getListById(listId: string): Promise<{ name: string } | null> {
  try {
    const list = await pb().collection("task_lists").getOne(listId);
    return { name: list.name };
  } catch {
    return null;
  }
}

export async function updateRooms(rooms: RoomDef[]) {
  await pb().collection("task_lists").update(currentListId, {
    room_defs: rooms,
  });
}

// ===== Task operations =====

export async function addTask(task: Omit<Task, "id">): Promise<string> {
  const record = await pb().collection("tasks").create({
    list: currentListId,
    name: task.name,
    description: task.description,
    room_id: task.roomId,
    frequency: task.frequency,
    last_completed: task.lastCompleted ? task.lastCompleted.toISOString() : "",
    snoozed_until: task.snoozedUntil ? task.snoozedUntil.toISOString() : "",
    notify_users: task.notifyUsers || [],
    created_by: task.createdBy,
  }, { $autoCancel: false });
  return record.id;
}

export async function updateTask(taskId: string, updates: Partial<{
  name: string;
  description: string;
  room_id: string;
  frequency: { value: number; unit: string };
  last_completed: string;
  snoozed_until: string;
}>) {
  await pb().collection("tasks").update(taskId, updates);
}

export async function snoozeTask(taskId: string, until: Date): Promise<void> {
  await pb().collection("tasks").update(taskId, {
    snoozed_until: until.toISOString(),
  });
}

export async function unsnoozeTask(taskId: string): Promise<void> {
  await pb().collection("tasks").update(taskId, {
    snoozed_until: "",
  });
}

export async function deleteTask(taskId: string) {
  await pb().collection("tasks").delete(taskId);
}

export async function completeTask(
  taskId: string,
  userId: string,
  notes: string = "",
  options?: { completedAt?: Date; currentLastCompleted?: Date }
): Promise<void> {
  const completionTime = options?.completedAt || new Date();
  const completionIso = completionTime.toISOString();

  // Only update lastCompleted if this completion is more recent than current
  const shouldUpdateLastCompleted = !options?.currentLastCompleted ||
    completionTime.getTime() > options.currentLastCompleted.getTime();

  if (shouldUpdateLastCompleted) {
    await pb().collection("tasks").update(taskId, {
      last_completed: completionIso,
    });
  }

  // Create completion event
  await pb().collection("task_events").create({
    list: currentListId,
    subject_id: taskId,
    timestamp: completionIso,
    created_by: userId,
    data: { notes },
  });
}

export async function updateCompletion(
  eventId: string,
  updates: { notes?: string; timestamp?: Date },
): Promise<void> {
  const updateData: Record<string, unknown> = {};

  if (updates.timestamp !== undefined) {
    updateData.timestamp = updates.timestamp.toISOString();
  }
  if (updates.notes !== undefined) {
    // Need to read existing data, merge notes, and write back
    const existing = await pb().collection("task_events").getOne(eventId);
    const data = (existing.data as Record<string, unknown>) || {};
    updateData.data = { ...data, notes: updates.notes };
  }

  await pb().collection("task_events").update(eventId, updateData);
}

export async function deleteCompletion(eventId: string): Promise<void> {
  await pb().collection("task_events").delete(eventId);
}

// ===== User slug operations =====

export async function getUserSlugs(userId: string, opts?: Record<string, unknown>): Promise<Record<string, string>> {
  try {
    const user = await pb().collection("users").getOne(userId, opts);
    return user.household_slugs || {};
  } catch {
    return {};
  }
}

export async function setUserSlug(userId: string, slug: string, listId: string, opts?: Record<string, unknown>) {
  const user = await pb().collection("users").getOne(userId, opts);
  const slugs = { ...(user.household_slugs || {}), [slug]: listId };
  await pb().collection("users").update(userId, { household_slugs: slugs }, opts);

  // Add user to list owners
  try {
    const list = await pb().collection("task_lists").getOne(listId);
    if (!list.owners.includes(userId)) {
      await pb().collection("task_lists").update(listId, {
        owners: [...(Array.isArray(list.owners) ? list.owners : [list.owners]), userId],
      });
    }
  } catch {
    // List may not exist yet
  }
}

export async function removeUserSlug(userId: string, slug: string) {
  const user = await pb().collection("users").getOne(userId);
  const slugs = { ...(user.household_slugs || {}) };
  delete slugs[slug];
  await pb().collection("users").update(userId, { household_slugs: slugs });
}

export async function renameUserSlug(userId: string, oldSlug: string, newSlug: string) {
  const user = await pb().collection("users").getOne(userId);
  const slugs = { ...(user.household_slugs || {}) };
  if (slugs[oldSlug]) {
    slugs[newSlug] = slugs[oldSlug];
    delete slugs[oldSlug];
    await pb().collection("users").update(userId, { household_slugs: slugs });
  }
}

// ===== Notification operations =====

export async function toggleTaskNotification(taskId: string, userId: string, enable: boolean) {
  if (enable) {
    await pb().collection("tasks").update(taskId, { "notify_users+": userId });
  } else {
    await pb().collection("tasks").update(taskId, { "notify_users-": userId });
  }
}

export async function saveFcmToken(userId: string, token: string) {
  try {
    const user = await pb().collection("users").getOne(userId);
    const tokens: string[] = user.fcm_tokens || [];
    if (!tokens.includes(token)) {
      await pb().collection("users").update(userId, { "fcm_tokens+": token });
    }
  } catch {
    // User record might not have fcm_tokens field yet
  }
}

export async function removeFcmToken(userId: string, token: string) {
  await pb().collection("users").update(userId, { "fcm_tokens-": token });
}

import type { NotificationMode } from "./types";

export async function getNotificationMode(userId: string): Promise<NotificationMode> {
  try {
    const user = await pb().collection("users").getOne(userId);
    return user.upkeep_notification_mode || "subscribed";
  } catch {
    return "subscribed";
  }
}

export async function setNotificationMode(userId: string, mode: NotificationMode) {
  await pb().collection("users").update(userId, { upkeep_notification_mode: mode });
}

// Re-export for compatibility with old import paths
export function getListRef() { return currentListId; }
export function getUserRef(userId: string) { return userId; }
