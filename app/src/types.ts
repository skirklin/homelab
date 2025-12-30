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
  name: string;
  categoryId: CategoryId;
  checked: boolean;
  addedBy: string;
  addedAt: Date;
  checkedBy?: string;
  checkedAt?: Date;
}

export interface GroceryItemStore {
  name: string;
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

export function itemFromStore(
  id: string,
  data: GroceryItemStore
): GroceryItem {
  return {
    id,
    name: data.name,
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
    name: item.name,
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

// Item history for autocomplete
export interface ItemHistory {
  name: string;
  categoryId: CategoryId;
  lastAdded: Date;
}

export interface ItemHistoryStore {
  name: string;
  categoryId: CategoryId;
  lastAdded: Timestamp;
}

// Shopping trip record
export interface ShoppingTripItem {
  name: string;
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

// User profile for tracking accessible lists via slugs
export interface UserProfile {
  slugs: Record<string, string>;  // { "groceries": "listId123", "rei": "listId456" }
}

export interface UserProfileStore {
  slugs: Record<string, string>;
}
