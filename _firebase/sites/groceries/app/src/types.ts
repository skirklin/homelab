import { Timestamp } from "firebase/firestore";

// Category definition with stable ID for renaming
export interface CategoryDef {
  id: string;
  name: string;
}

// Category ID used for referencing (stored on items)
export type CategoryId = string;

export interface GroceryItem {
  id: string;
  ingredient: string;
  note?: string;
  categoryId: CategoryId;
  checked: boolean;
  addedBy: string;
  addedAt: Date;
  checkedBy?: string;
  checkedAt?: Date;
}

export interface GroceryItemStore {
  ingredient: string;
  note?: string;
  categoryId: CategoryId;
  checked: boolean;
  addedBy: string;
  addedAt: Timestamp;
  checkedBy?: string;
  checkedAt?: Timestamp;
}

export interface GroceryList {
  id: string;
  name: string;
  owners: string[];
  categories: CategoryDef[];
  created: Date;
  updated: Date;
}

export interface GroceryListStore {
  name: string;
  owners: string[];
  categoryDefs: CategoryDef[];
  created: Timestamp;
  updated: Timestamp;
}

// Legacy store format for backward compatibility
interface LegacyGroceryItemStore {
  name?: string;
}

export function itemFromStore(
  id: string,
  data: GroceryItemStore
): GroceryItem {
  // Handle legacy items that only have 'name' field
  const legacy = data as GroceryItemStore & LegacyGroceryItemStore;
  return {
    id,
    ingredient: data.ingredient || legacy.name || "",
    note: data.note,
    categoryId: data.categoryId || "uncategorized",
    checked: data.checked,
    addedBy: data.addedBy,
    addedAt: data.addedAt.toDate(),
    checkedBy: data.checkedBy,
    checkedAt: data.checkedAt?.toDate(),
  };
}

export function itemToStore(item: Omit<GroceryItem, "id">): GroceryItemStore {
  return {
    ingredient: item.ingredient,
    note: item.note,
    categoryId: item.categoryId,
    checked: item.checked,
    addedBy: item.addedBy,
    addedAt: Timestamp.fromDate(item.addedAt),
    checkedBy: item.checkedBy,
    checkedAt: item.checkedAt ? Timestamp.fromDate(item.checkedAt) : undefined,
  };
}

export function listFromStore(id: string, data: GroceryListStore): GroceryList {
  return {
    id,
    name: data.name,
    owners: data.owners,
    categories: data.categoryDefs || [],
    created: data.created.toDate(),
    updated: data.updated.toDate(),
  };
}

// Item history for autocomplete (keyed by normalized ingredient)
export interface ItemHistory {
  ingredient: string;
  categoryId: CategoryId;
  lastAdded: Date;
}

export interface ItemHistoryStore {
  ingredient: string;
  categoryId: CategoryId;
  lastAdded: Timestamp;
}

// Legacy history format for backward compatibility
export interface LegacyItemHistoryStore {
  name?: string;
}

// Shopping trip record
export interface ShoppingTripItem {
  ingredient: string;
  note?: string;
  categoryId: CategoryId;
}

export interface ShoppingTrip {
  id: string;
  completedAt: Date;
  items: ShoppingTripItem[];
}

export interface ShoppingTripStore {
  completedAt: Timestamp;
  items: ShoppingTripItem[];
}

// User profile - re-exported from shared
// Groceries uses the 'slugs' field for list mapping
export type { UserProfile, UserProfileStore } from "@kirkl/shared";
