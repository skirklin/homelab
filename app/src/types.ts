import { Timestamp } from "firebase/firestore";

export const CATEGORIES = [
  "produce",
  "dairy",
  "meat",
  "bakery",
  "frozen",
  "pantry",
  "beverages",
  "household",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  produce: "Produce",
  dairy: "Dairy",
  meat: "Meat & Seafood",
  bakery: "Bakery",
  frozen: "Frozen",
  pantry: "Pantry",
  beverages: "Beverages",
  household: "Household",
  other: "Other",
};

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
  created: Date;
  updated: Date;
}

export interface GroceryListStore {
  name: string;
  owners: string[];
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
    created: data.created.toDate(),
    updated: data.updated.toDate(),
  };
}
