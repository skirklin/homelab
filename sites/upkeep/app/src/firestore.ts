import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  Timestamp,
  getDoc,
  updateDoc,
  addDoc,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";
import { db } from "./backend";
import type { Task, TaskStore, RoomDef, CompletionStore, UserProfileStore } from "./types";
import { taskToStore } from "./types";

// Current list ID - set by the router
let currentListId = "default";

export function setCurrentListId(listId: string) {
  currentListId = listId;
}

export function getCurrentListId() {
  return currentListId;
}

export function getListRef(listId?: string) {
  return doc(db, "taskLists", listId || currentListId);
}

export function getTasksRef(listId?: string) {
  return collection(db, "taskLists", listId || currentListId, "tasks");
}

export function getTaskRef(taskId: string, listId?: string) {
  return doc(db, "taskLists", listId || currentListId, "tasks", taskId);
}

export function getCompletionsRef(listId?: string) {
  return collection(db, "taskLists", listId || currentListId, "completions");
}

export function getUserRef(userId: string) {
  return doc(db, "users", userId);
}

export async function ensureListExists(userId: string) {
  const listRef = getListRef();
  const listSnap = await getDoc(listRef);

  if (listSnap.exists()) {
    // Add user to owners if not already there
    const data = listSnap.data();
    if (!data.owners.includes(userId)) {
      await updateDoc(listRef, {
        owners: [...data.owners, userId],
      });
    }
  }
  // If list doesn't exist, we don't auto-create - user must create explicitly
}

export async function addTask(
  task: Omit<Task, "id">,
): Promise<string> {
  const taskRef = doc(getTasksRef());
  const taskData = taskToStore(task);
  await setDoc(taskRef, taskData);
  return taskRef.id;
}

export async function updateTask(taskId: string, updates: Partial<TaskStore>) {
  const taskRef = getTaskRef(taskId);
  await updateDoc(taskRef, { ...updates, updatedAt: Timestamp.now() });
}

export async function deleteTask(taskId: string) {
  const taskRef = getTaskRef(taskId);
  await deleteDoc(taskRef);
}

export async function completeTask(
  taskId: string,
  userId: string,
  notes: string = "",
  completedAt?: Date
): Promise<void> {
  const completionTime = completedAt ? Timestamp.fromDate(completedAt) : Timestamp.now();
  const now = Timestamp.now();

  // Get current task to check if this completion is the latest
  const taskRef = getTaskRef(taskId);
  const taskSnap = await getDoc(taskRef);
  const taskData = taskSnap.data();

  // Only update lastCompleted if this completion is more recent than current
  const shouldUpdateLastCompleted = !taskData?.lastCompleted ||
    completionTime.toMillis() > taskData.lastCompleted.toMillis();

  if (shouldUpdateLastCompleted) {
    await updateDoc(taskRef, {
      lastCompleted: completionTime,
      updatedAt: now,
    });
  }

  // Create completion record
  const completionData: CompletionStore = {
    taskId,
    completedBy: userId,
    completedAt: completionTime,
    notes,
  };
  await addDoc(getCompletionsRef(), completionData);
}

export async function updateRooms(rooms: RoomDef[]) {
  const listRef = getListRef();
  await updateDoc(listRef, { roomDefs: rooms, updated: Timestamp.now() });
}

// User profile functions
// Uses 'householdSlugs' field to avoid conflict with groceries app
export async function getUserSlugs(userId: string): Promise<Record<string, string>> {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    return data.householdSlugs || {};
  }
  return {};
}

export async function setUserSlug(userId: string, slug: string, listId: string) {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    const householdSlugs = { ...data.householdSlugs, [slug]: listId };
    await updateDoc(userRef, { householdSlugs });
  } else {
    await setDoc(userRef, { householdSlugs: { [slug]: listId } });
  }

  // Add user to list owners if not already there (for joining shared lists)
  const listRef = getListRef(listId);
  await updateDoc(listRef, { owners: arrayUnion(userId) });
}

export async function removeUserSlug(userId: string, slug: string) {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    const householdSlugs = { ...data.householdSlugs };
    delete householdSlugs[slug];
    await updateDoc(userRef, { householdSlugs });
  }
}

export async function renameUserSlug(userId: string, oldSlug: string, newSlug: string) {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    const householdSlugs = { ...data.householdSlugs };
    if (householdSlugs[oldSlug]) {
      householdSlugs[newSlug] = householdSlugs[oldSlug];
      delete householdSlugs[oldSlug];
      await updateDoc(userRef, { householdSlugs });
    }
  }
}

// Create a new task list with a user slug
export async function createList(name: string, slug: string, userId: string): Promise<string> {
  const listsRef = collection(db, "taskLists");
  const newListRef = doc(listsRef);

  await setDoc(newListRef, {
    name,
    owners: [userId],
    roomDefs: [],
    created: Timestamp.now(),
    updated: Timestamp.now(),
  });

  // Add slug mapping to user's profile
  await setUserSlug(userId, slug, newListRef.id);

  return newListRef.id;
}

export async function renameList(listId: string, newName: string) {
  const listRef = getListRef(listId);
  await updateDoc(listRef, { name: newName, updated: Timestamp.now() });
}

export async function deleteList(listId: string) {
  const listRef = getListRef(listId);
  await deleteDoc(listRef);
}

// Get list by ID (for joining shared lists)
export async function getListById(listId: string): Promise<{ name: string } | null> {
  const listRef = doc(db, "taskLists", listId);
  const listSnap = await getDoc(listRef);
  if (listSnap.exists()) {
    return { name: listSnap.data().name };
  }
  return null;
}

// Notification functions

export async function toggleTaskNotification(taskId: string, userId: string, enable: boolean) {
  const taskRef = getTaskRef(taskId);
  if (enable) {
    await updateDoc(taskRef, { notifyUsers: arrayUnion(userId) });
  } else {
    await updateDoc(taskRef, { notifyUsers: arrayRemove(userId) });
  }
}

export async function saveFcmToken(userId: string, token: string) {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    await updateDoc(userRef, { fcmTokens: arrayUnion(token) });
  } else {
    await setDoc(userRef, { householdSlugs: {}, fcmTokens: [token] });
  }
}

export async function removeFcmToken(userId: string, token: string) {
  const userRef = getUserRef(userId);
  await updateDoc(userRef, { fcmTokens: arrayRemove(token) });
}
