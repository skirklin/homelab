// Category definition with stable ID for renaming
export interface CategoryDef {
  id: string;
  name: string;
}

export type CategoryId = string;

/**
 * Reserved category ID for items that haven't been assigned to a user-configured
 * category. The backend also writes this string at the protocol boundary (see
 * `packages/backend/src/pocketbase/shopping.ts`) — keep them in sync if changed.
 */
export const UNCATEGORIZED_CATEGORY_ID = "uncategorized";

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

