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
  arrayUnion,
} from "firebase/firestore";
import { db } from "./backend";
import type { GroceryItem, GroceryItemStore, CategoryId, CategoryDef, ItemHistoryStore, ShoppingTripStore, UserProfileStore } from "./types";

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

export async function addItem(
  name: string,
  userId: string,
  options?: { itemId?: string; categoryId?: string }
) {
  // Use provided categoryId or look up from history
  let categoryId: string = options?.categoryId || "uncategorized";
  if (!options?.categoryId) {
    const historyRef = doc(getHistoryRef(), normalizeItemName(name));
    const historySnap = await getDoc(historyRef);
    const historyData = historySnap.exists() ? historySnap.data() : null;
    categoryId = historyData?.categoryId || "uncategorized";
  }

  // Use provided itemId or generate new one
  const itemRef = options?.itemId
    ? doc(getItemsRef(), options.itemId)
    : doc(getItemsRef());
  const itemData: GroceryItemStore = {
    name,
    categoryId,
    checked: false,
    addedBy: userId,
    addedAt: Timestamp.now(),
  };
  await setDoc(itemRef, itemData);

  // Save to history for autocomplete (preserves the name with correct casing)
  const historyRef = doc(getHistoryRef(), normalizeItemName(name));
  const newHistoryData: ItemHistoryStore = { name, categoryId, lastAdded: Timestamp.now() };
  await setDoc(historyRef, newHistoryData);
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

export async function updateItemCategory(item: GroceryItem, newCategoryId: CategoryId) {
  const itemRef = getItemRef(item.id);
  await updateDoc(itemRef, { categoryId: newCategoryId });

  // Update history too
  const historyRef = doc(getHistoryRef(), normalizeItemName(item.name));
  await setDoc(historyRef, { name: item.name, categoryId: newCategoryId, lastAdded: Timestamp.now() });
}

export async function clearCheckedItems(items: GroceryItem[]) {
  const checkedItems = items.filter((item) => item.checked);
  if (checkedItems.length === 0) return;

  // Record this shopping trip
  const tripData: ShoppingTripStore = {
    completedAt: Timestamp.now(),
    items: checkedItems.map((item) => ({
      name: item.name,
      categoryId: item.categoryId,
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

export async function updateCategories(categories: CategoryDef[]) {
  const listRef = getListRef();
  await updateDoc(listRef, { categoryDefs: categories });
}

// User profile functions
export async function getUserSlugs(userId: string): Promise<Record<string, string>> {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    return data.slugs || {};
  }
  return {};
}

export async function setUserSlug(userId: string, slug: string, listId: string) {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    const slugs = { ...data.slugs, [slug]: listId };
    await updateDoc(userRef, { slugs });
  } else {
    await setDoc(userRef, { slugs: { [slug]: listId } });
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
    const slugs = { ...data.slugs };
    delete slugs[slug];
    await updateDoc(userRef, { slugs });
  }
}

export async function renameUserSlug(userId: string, oldSlug: string, newSlug: string) {
  const userRef = getUserRef(userId);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    const data = userSnap.data() as UserProfileStore;
    const slugs = { ...data.slugs };
    if (slugs[oldSlug]) {
      slugs[newSlug] = slugs[oldSlug];
      delete slugs[oldSlug];
      await updateDoc(userRef, { slugs });
    }
  }
}

// Create a new list with a user slug
export async function createList(name: string, slug: string, userId: string): Promise<string> {
  const listsRef = collection(db, "lists");
  const newListRef = doc(listsRef);

  await setDoc(newListRef, {
    name,
    owners: [userId],
    categoryDefs: [],  // Start with no categories
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
  // Note: This doesn't delete subcollections (items, history, trips)
  // For a production app, you'd want a Cloud Function to clean those up
  const listRef = getListRef(listId);
  await deleteDoc(listRef);
}

// Get list by ID (for adding shared lists)
export async function getListById(listId: string): Promise<{ name: string } | null> {
  const listRef = doc(db, "lists", listId);
  const listSnap = await getDoc(listRef);
  if (listSnap.exists()) {
    return { name: listSnap.data().name };
  }
  return null;
}
