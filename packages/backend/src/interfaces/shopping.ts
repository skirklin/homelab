/**
 * Shopping backend interface.
 *
 * Covers: lists, items, categories, history, and shopping trips.
 * Subscriptions deliver full current state (not deltas).
 */
import type { Unsubscribe } from "../types/common";
import type {
  ShoppingList,
  ShoppingItem,
  CategoryDef,
  HistoryEntry,
  ShoppingTrip,
} from "../types/shopping";

export interface ShoppingBackend {
  // --- List CRUD ---

  createList(name: string, userId: string): Promise<string>;
  renameList(listId: string, name: string): Promise<void>;
  deleteList(listId: string): Promise<void>;
  getList(listId: string): Promise<ShoppingList | null>;

  // --- Categories ---

  updateCategories(listId: string, categories: CategoryDef[]): Promise<void>;

  // --- Item CRUD ---

  addItem(
    listId: string,
    ingredient: string,
    userId: string,
    options?: { categoryId?: string; note?: string },
  ): Promise<string>;

  updateItem(itemId: string, updates: { ingredient?: string; note?: string }): Promise<void>;
  updateItemCategory(itemId: string, categoryId: string, ingredient: string): Promise<void>;
  toggleItem(itemId: string, checked: boolean, userId: string): Promise<void>;
  deleteItem(itemId: string): Promise<void>;

  /** Remove all checked items and record as a completed shopping trip. */
  clearCheckedItems(listId: string, items: ShoppingItem[]): Promise<void>;

  // --- Subscriptions ---

  /**
   * Subscribe to all data for a shopping list.
   * Callbacks receive full current state on initial load and after every change.
   */
  subscribeToList(
    listId: string,
    handlers: {
      onList: (list: ShoppingList) => void;
      onItems: (items: ShoppingItem[]) => void;
      onHistory: (entries: HistoryEntry[]) => void;
      onTrips: (trips: ShoppingTrip[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe;
}
