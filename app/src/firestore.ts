import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  writeBatch,
  Timestamp,
  getDoc,
  updateDoc,
  addDoc,
} from "firebase/firestore";
import { db } from "./backend";
import type { GroceryItem, GroceryItemStore, Category, ItemHistoryStore, ShoppingTripStore, UserProfileStore } from "./types";
import { DEFAULT_CATEGORIES } from "./types";

// Current list ID - set by the router
let currentListId = "default";

export function setCurrentListId(listId: string) {
  currentListId = listId;
}

export function getCurrentListId() {
  return currentListId;
}

export function getListRef(listId?: string) {
  return doc(db, "lists", listId || currentListId);
}

export function getItemsRef(listId?: string) {
  return collection(db, "lists", listId || currentListId, "items");
}

export function getItemRef(itemId: string, listId?: string) {
  return doc(db, "lists", listId || currentListId, "items", itemId);
}

export function getHistoryRef(listId?: string) {
  return collection(db, "lists", listId || currentListId, "history");
}

export function getTripsRef(listId?: string) {
  return collection(db, "lists", listId || currentListId, "trips");
}

export function getUserRef(userId: string) {
  return doc(db, "users", userId);
}

function normalizeItemName(name: string): string {
  return name.toLowerCase().trim();
}

export async function ensureListExists(userId: string) {
  const listRef = getListRef();
  const listSnap = await getDoc(listRef);

  if (!listSnap.exists()) {
    await setDoc(listRef, {
      name: "Groceries",
      owners: [userId],
      categories: DEFAULT_CATEGORIES,
      created: Timestamp.now(),
      updated: Timestamp.now(),
    });
  } else {
    // Add user to owners if not already there
    const data = listSnap.data();
    if (!data.owners.includes(userId)) {
      await updateDoc(listRef, {
        owners: [...data.owners, userId],
      });
    }
  }
}

export async function addItem(
  name: string,
  userId: string
) {
  // Look up category from history, default to "uncategorized"
  const historyRef = doc(getHistoryRef(), normalizeItemName(name));
  const historySnap = await getDoc(historyRef);
  const category = historySnap.exists()
    ? historySnap.data().category
    : "uncategorized";

  const itemRef = doc(getItemsRef());
  const itemData: GroceryItemStore = {
    name,
    category,
    checked: false,
    addedBy: userId,
    addedAt: Timestamp.now(),
  };
  await setDoc(itemRef, itemData);

  // Save to history for autocomplete (preserves the name with correct casing)
  const historyData: ItemHistoryStore = { name, category, lastAdded: Timestamp.now() };
  await setDoc(historyRef, historyData);
}

export async function toggleItem(item: GroceryItem, userId: string) {
  const itemRef = getItemRef(item.id);
  if (item.checked) {
    // Uncheck
    await updateDoc(itemRef, {
      checked: false,
      checkedBy: null,
      checkedAt: null,
    });
  } else {
    // Check
    await updateDoc(itemRef, {
      checked: true,
      checkedBy: userId,
      checkedAt: Timestamp.now(),
    });
  }
}

export async function deleteItem(itemId: string) {
  const itemRef = getItemRef(itemId);
  await deleteDoc(itemRef);
}

export async function updateItemCategory(item: GroceryItem, newCategory: Category) {
  const itemRef = getItemRef(item.id);
  await updateDoc(itemRef, { category: newCategory });

  // Update history too
  const historyRef = doc(getHistoryRef(), normalizeItemName(item.name));
  await setDoc(historyRef, { name: item.name, category: newCategory, lastAdded: Timestamp.now() });
}

export async function clearCheckedItems(items: GroceryItem[]) {
  const checkedItems = items.filter((item) => item.checked);
  if (checkedItems.length === 0) return;

  // Record this shopping trip
  const tripData: ShoppingTripStore = {
    completedAt: Timestamp.now(),
    items: checkedItems.map((item) => ({
      name: item.name,
      category: item.category,
    })),
  };
  await addDoc(getTripsRef(), tripData);

  // Delete the checked items
  const batch = writeBatch(db);
  for (const item of checkedItems) {
    batch.delete(getItemRef(item.id));
  }
  await batch.commit();
}

export async function updateCategories(categories: string[]) {
  const listRef = getListRef();
  await updateDoc(listRef, { categories });
}

// User profile functions
export async function getUserProfile(userId: string): Promise<{ id: string; name: string }[]> {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    return data.lists || [];
  }
  return [];
}

export async function addListToUserProfile(userId: string, listId: string, listName: string) {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    const lists = data.lists || [];
    // Don't add duplicates
    if (!lists.some(l => l.id === listId)) {
      lists.push({ id: listId, name: listName });
      await updateDoc(userRef, { lists });
    }
  } else {
    await setDoc(userRef, { lists: [{ id: listId, name: listName }] });
  }
}

export async function updateListNameInProfile(userId: string, listId: string, newName: string) {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    const lists = data.lists || [];
    const idx = lists.findIndex(l => l.id === listId);
    if (idx >= 0) {
      lists[idx].name = newName;
      await updateDoc(userRef, { lists });
    }
  }
}

export async function removeListFromUserProfile(userId: string, listId: string) {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    const lists = (data.lists || []).filter(l => l.id !== listId);
    await updateDoc(userRef, { lists });
  }
}

// Create a new list
export async function createList(name: string, userId: string): Promise<string> {
  const listsRef = collection(db, "lists");
  const newListRef = doc(listsRef);

  await setDoc(newListRef, {
    name,
    owners: [userId],
    categories: DEFAULT_CATEGORIES,
    created: Timestamp.now(),
    updated: Timestamp.now(),
  });

  // Add to user's profile
  await addListToUserProfile(userId, newListRef.id, name);

  return newListRef.id;
}

export async function renameList(listId: string, newName: string, userId: string) {
  const listRef = getListRef(listId);
  await updateDoc(listRef, { name: newName, updated: Timestamp.now() });
  await updateListNameInProfile(userId, listId, newName);
}

export async function deleteList(listId: string, userId: string) {
  // Note: This doesn't delete subcollections (items, history, trips)
  // For a production app, you'd want a Cloud Function to clean those up
  const listRef = getListRef(listId);
  await deleteDoc(listRef);
  await removeListFromUserProfile(userId, listId);
}
