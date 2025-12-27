import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  writeBatch,
  Timestamp,
  getDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "./backend";
import type { GroceryItem, GroceryItemStore, Category } from "./types";

const LIST_ID = "default"; // Single shared list for now

export function getListRef() {
  return doc(db, "lists", LIST_ID);
}

export function getItemsRef() {
  return collection(db, "lists", LIST_ID, "items");
}

export function getItemRef(itemId: string) {
  return doc(db, "lists", LIST_ID, "items", itemId);
}

export async function ensureListExists(userId: string) {
  const listRef = getListRef();
  const listSnap = await getDoc(listRef);

  if (!listSnap.exists()) {
    await setDoc(listRef, {
      name: "Groceries",
      owners: [userId],
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
  category: Category,
  userId: string
) {
  const itemRef = doc(getItemsRef());
  const itemData: GroceryItemStore = {
    name,
    category,
    checked: false,
    addedBy: userId,
    addedAt: Timestamp.now(),
  };
  await setDoc(itemRef, itemData);
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

export async function clearCheckedItems(items: GroceryItem[]) {
  const checkedItems = items.filter((item) => item.checked);
  console.log("Clearing checked items:", checkedItems.length);

  if (checkedItems.length === 0) {
    console.log("No checked items to clear");
    return;
  }

  const batch = writeBatch(db);
  for (const item of checkedItems) {
    console.log("Deleting item:", item.id, item.name);
    const itemRef = getItemRef(item.id);
    batch.delete(itemRef);
  }

  try {
    await batch.commit();
    console.log("Batch commit successful");
  } catch (error) {
    console.error("Error clearing items:", error);
    throw error;
  }
}
