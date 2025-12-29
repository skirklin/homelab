import { Timestamp } from "firebase/firestore";

// Default categories for new lists
export const DEFAULT_CATEGORIES = [
  "produce",
  "dairy",
  "meat",
  "pantry",
  "household",
];

// Category is now a string to support custom categories
export type Category = string;

export interface GroceryItem {
  id: string;
  name: string;
  category: Category;
  checked: boolean;
  addedBy: string;
  addedAt: Date;
  checkedBy?: string;
  checkedAt?: Date;
}

export interface GroceryItemStore {
  name: string;
  category: Category;
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
  categories: string[];
  created: Date;
  updated: Date;
}

export interface GroceryListStore {
  name: string;
  owners: string[];
  categories: string[];
  created: Timestamp;
  updated: Timestamp;
}

// Converters
export function itemFromStore(
  id: string,
  data: GroceryItemStore
): GroceryItem {
  return {
    id,
    name: data.name,
    category: data.category,
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
    category: item.category,
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
    categories: data.categories || DEFAULT_CATEGORIES,
    created: data.created.toDate(),
    updated: data.updated.toDate(),
  };
}

// Item history for autocomplete
export interface ItemHistory {
  name: string;
  category: Category;
  lastAdded: Date;
}

export interface ItemHistoryStore {
  name: string;
  category: Category;
  lastAdded: Timestamp;
}

// Shopping trip record
export interface ShoppingTripItem {
  name: string;
  category: Category;
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

// User profile for tracking accessible lists
export interface UserProfile {
  lists: { id: string; name: string }[];
}

export interface UserProfileStore {
  lists: { id: string; name: string }[];
}
