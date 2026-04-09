/** Shopping domain types */

export interface ShoppingList {
  id: string;
  name: string;
  owners: string[];
  categories: CategoryDef[];
}

export interface CategoryDef {
  id: string;
  name: string;
  color?: string;
}

export interface ShoppingItem {
  id: string;
  list: string;
  ingredient: string;
  note: string;
  categoryId: string;
  checked: boolean;
  checkedBy?: string;
  checkedAt?: string;
  addedBy?: string;
}

export interface HistoryEntry {
  id: string;
  ingredient: string;
  categoryId: string;
  lastAdded: Date;
}

export interface ShoppingTrip {
  id: string;
  list: string;
  completedAt: Date;
  items: TripItem[];
}

export interface TripItem {
  ingredient: string;
  note: string;
  categoryId: string;
}
