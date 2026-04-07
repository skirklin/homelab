// Category definition with stable ID for renaming
export interface CategoryDef {
  id: string;
  name: string;
}

export type CategoryId = string;

export interface ShoppingItem {
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

export interface ShoppingList {
  id: string;
  name: string;
  owners: string[];
  categories: CategoryDef[];
  created: Date;
  updated: Date;
}

export interface ItemHistory {
  ingredient: string;
  categoryId: CategoryId;
  lastAdded: Date;
}

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

export type { UserProfile, UserProfileStore } from "@kirkl/shared";

export type ItemHistoryStore = ItemHistory;
export type LegacyItemHistoryStore = { name?: string };
export type ShoppingTripStore = ShoppingTrip;

// Converters — PocketBase records come as plain objects with ISO date strings
export function itemFromRecord(record: Record<string, unknown>): ShoppingItem {
  return {
    id: record.id as string,
    ingredient: record.ingredient as string || "",
    note: record.note as string | undefined,
    categoryId: (record.category_id as string) || "uncategorized",
    checked: record.checked as boolean || false,
    addedBy: record.added_by as string || "",
    addedAt: new Date(record.created as string),
    checkedBy: record.checked_by as string | undefined,
    checkedAt: record.checked_at ? new Date(record.checked_at as string) : undefined,
  };
}

export function listFromRecord(record: Record<string, unknown>): ShoppingList {
  return {
    id: record.id as string,
    name: record.name as string || "",
    owners: record.owners as string[] || [],
    categories: (record.category_defs as CategoryDef[]) || [],
    created: new Date(record.created as string),
    updated: new Date(record.updated as string),
  };
}

// Keep old names as aliases
export const itemFromStore = itemFromRecord;
export const listFromStore = listFromRecord;
