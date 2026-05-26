/**
 * Shopping backend interface.
 *
 * Covers: lists, items, categories, and shopping trips. Autocomplete
 * suggestions are derived client-side from trips — there is no separate
 * `shopping_history` collection anymore (retired May 2026).
 *
 * Subscriptions deliver full current state (not deltas).
 */
import type { Unsubscribe } from "../types/common";
import type {
  ShoppingList,
  ShoppingItem,
  CategoryDef,
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

  /** Caller must look up `categoryId` from local suggestions (derived from trips
   *  via `deriveSuggestions`) — adapter does not infer it. */
  addItem(
    listId: string,
    ingredient: string,
    userId: string,
    categoryId: string,
    note?: string,
  ): Promise<string>;

  updateItem(itemId: string, updates: { ingredient?: string; note?: string }): Promise<void>;
  updateItemCategory(itemId: string, categoryId: string): Promise<void>;
  toggleItem(itemId: string, checked: boolean, userId: string): Promise<void>;
  deleteItem(itemId: string): Promise<void>;

  /** Remove all checked items and record as a completed shopping trip.
   *  Caller passes the current item snapshot so the trip record captures
   *  ingredient/note/category exactly as they were when checked. */
  clearCheckedItems(
    listId: string,
    items: Pick<ShoppingItem, "id" | "ingredient" | "note" | "categoryId" | "checked">[],
  ): Promise<void>;

  // --- Trip-item surgical edits ---
  //
  // Trips are JSON-array records, addressed by (tripId, itemIndex). These ops
  // load → patch index → write the trip back, using the optimistic-view-first
  // pattern so a still-pending edit on the same trip is visible without a
  // round-trip. Editing a trip item changes future autocomplete suggestions
  // (see `deriveSuggestions`) — that's the whole point of editing in place.

  updateTripItem(
    tripId: string,
    itemIndex: number,
    patch: { ingredient?: string; note?: string; categoryId?: string },
  ): Promise<void>;

  removeTripItem(tripId: string, itemIndex: number): Promise<void>;

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
      onTrips: (trips: ShoppingTrip[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe;
}
