/**
 * PocketBase implementation of ShoppingBackend.
 *
 * Writes route through the optimistic wrapper (wrapPocketBase) so the UI
 * sees changes within a frame. Reads on every collection go through PBMirror
 * — one centralized subscription engine that handles cancel-before-resolve,
 * SSE coalescing, mutation-queue overlay, and full-state delivery. This file
 * is the first backend to adopt the mirror; the others migrate in follow-up
 * PRs (see `packages/backend/src/wrapped-pb/mirror.ts`).
 *
 * Autocomplete suggestions are derived client-side from trips (see
 * `apps/shopping/app/src/suggestions.ts`) — there is no `shopping_history`
 * collection backing them anymore (retired May 2026).
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { ShoppingBackend } from "../interfaces/shopping";
import type { ShoppingList, ShoppingItem, CategoryDef, ShoppingTrip } from "../types/shopping";
import type { Unsubscribe } from "../types/common";
import { newId } from "../wrapped-pb/ids";
import type { WrappedPocketBase } from "../wrapped-pb";
import type { PBMirror, RawRecord } from "../wrapped-pb/mirror";

// --- Pagination limits ---

const TRIPS_PAGE_SIZE = 50;

/** Single chokepoint for ingredient casing/whitespace. Stored items, trip
 *  snapshots, and suggestion keys all collapse on this form so "Parsley"
 *  and "parsley " never split into two catalog entries. */
function normalizeIngredient(s: string): string {
  return s.toLowerCase().trim();
}

// --- Record → domain type mappers ---

function listFromRecord(r: RecordModel | RawRecord): ShoppingList {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    name: (x.name as string) || "",
    owners: Array.isArray(x.owners) ? (x.owners as string[]) : [],
    categories: Array.isArray(x.category_defs) ? (x.category_defs as CategoryDef[]) : [],
    created: (x.created as string) ?? "",
    updated: (x.updated as string) ?? "",
  };
}

function itemFromRecord(r: RecordModel | RawRecord): ShoppingItem {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    list: x.list as string,
    ingredient: (x.ingredient as string) || "",
    note: (x.note as string) || "",
    categoryId: (x.category_id as string) || "uncategorized",
    checked: !!x.checked,
    checkedBy: (x.checked_by as string) || undefined,
    checkedAt: (x.checked_at as string) || undefined,
    addedBy: (x.added_by as string) || undefined,
    addedAt: x.created as string,
    created: x.created as string,
    updated: x.updated as string,
  };
}

/** Raw shape of the `items` JSON column on a `shopping_trips` row. */
interface TripItemRaw {
  ingredient?: string;
  /** Legacy field name from very old records — first ever wave used `name`. */
  name?: string;
  note?: string;
  categoryId?: string;
}

function tripItemsFromRecord(r: RecordModel | RawRecord): TripItemRaw[] {
  const x = r as Record<string, unknown>;
  return Array.isArray(x.items) ? (x.items as TripItemRaw[]) : [];
}

function tripFromRecord(r: RecordModel | RawRecord): ShoppingTrip {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    list: x.list as string,
    completedAt: new Date(x.completed_at as string),
    items: tripItemsFromRecord(r).map((item) => ({
      ingredient: item.ingredient || item.name || "",
      note: item.note || "",
      categoryId: item.categoryId || "uncategorized",
    })),
  };
}

export class PocketBaseShoppingBackend implements ShoppingBackend {
  private wpb: WrappedPocketBase;
  private mirror: PBMirror;

  constructor(private pb: () => PocketBase, wpb: WrappedPocketBase, mirror: PBMirror) {
    this.wpb = wpb;
    this.mirror = mirror;
  }

  async createList(name: string, userId: string): Promise<string> {
    const id = newId();
    await this.wpb.collection("shopping_lists").create({
      id,
      name,
      owners: [userId],
      category_defs: [],
    }, { $autoCancel: false });
    return id;
  }

  async renameList(listId: string, name: string): Promise<void> {
    await this.wpb.collection("shopping_lists").update(listId, { name });
  }

  async deleteList(listId: string): Promise<void> {
    await this.wpb.collection("shopping_lists").delete(listId);
  }

  async getList(listId: string): Promise<ShoppingList | null> {
    try {
      const r = await this.pb().collection("shopping_lists").getOne(listId);
      return listFromRecord(r);
    } catch {
      return null;
    }
  }

  async updateCategories(listId: string, categories: CategoryDef[]): Promise<void> {
    await this.wpb.collection("shopping_lists").update(listId, {
      category_defs: categories,
    });
  }

  async addItem(
    listId: string,
    ingredient: string,
    userId: string,
    categoryId: string,
    note?: string,
  ): Promise<string> {
    const itemId = newId();
    await this.wpb.collection("shopping_items").create({
      id: itemId,
      list: listId,
      ingredient: normalizeIngredient(ingredient),
      note: note || "",
      category_id: categoryId,
      checked: false,
      added_by: userId,
    }, { $autoCancel: false });
    return itemId;
  }

  async updateItem(itemId: string, updates: { ingredient?: string; note?: string }): Promise<void> {
    const data: Record<string, string> = {};
    if (updates.ingredient !== undefined) data.ingredient = normalizeIngredient(updates.ingredient);
    if (updates.note !== undefined) data.note = updates.note || "";
    await this.wpb.collection("shopping_items").update(itemId, data);
  }

  async updateItemCategory(itemId: string, categoryId: string): Promise<void> {
    await this.wpb.collection("shopping_items").update(itemId, { category_id: categoryId });
  }

  async toggleItem(itemId: string, checked: boolean, userId: string): Promise<void> {
    if (checked) {
      await this.wpb.collection("shopping_items").update(itemId, {
        checked: true,
        checked_by: userId,
        checked_at: new Date().toISOString(),
      });
    } else {
      await this.wpb.collection("shopping_items").update(itemId, {
        checked: false,
        checked_by: "",
        checked_at: "",
      });
    }
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.wpb.collection("shopping_items").delete(itemId);
  }

  async clearCheckedItems(
    listId: string,
    items: Pick<ShoppingItem, "id" | "ingredient" | "note" | "categoryId" | "checked">[],
  ): Promise<void> {
    const checkedItems = items.filter((item) => item.checked);
    if (checkedItems.length === 0) return;

    await this.wpb.collection("shopping_trips").create({
      id: newId(),
      list: listId,
      completed_at: new Date().toISOString(),
      items: checkedItems.map((item) => ({
        ingredient: item.ingredient,
        ...(item.note ? { note: item.note } : {}),
        categoryId: item.categoryId,
      })),
    });

    await Promise.all(
      checkedItems.map((item) => this.wpb.collection("shopping_items").delete(item.id)),
    );
  }

  async updateTripItem(
    tripId: string,
    itemIndex: number,
    patch: { ingredient?: string; note?: string; categoryId?: string },
  ): Promise<void> {
    const trip = await this.loadTrip(tripId);
    const items = tripItemsFromRecord(trip);
    if (itemIndex < 0 || itemIndex >= items.length) {
      throw new Error(`updateTripItem: index ${itemIndex} out of range (0..${items.length - 1})`);
    }
    // Reject obvious garbage early — a blank rename would silently retire the
    // suggestion derived from this trip item, which is rarely what the user
    // wants. Delete is the right tool for that.
    const normalizedIngredient =
      patch.ingredient !== undefined ? normalizeIngredient(patch.ingredient) : undefined;
    if (normalizedIngredient !== undefined && !normalizedIngredient) {
      throw new Error("updateTripItem: ingredient cannot be empty");
    }
    const nextItems = items.map((item, i) => {
      if (i !== itemIndex) return item;
      const next: TripItemRaw = { ...item };
      if (normalizedIngredient !== undefined) next.ingredient = normalizedIngredient;
      if (patch.note !== undefined) next.note = patch.note;
      if (patch.categoryId !== undefined) next.categoryId = patch.categoryId;
      return next;
    });
    await this.wpb.collection("shopping_trips").update(tripId, { items: nextItems });
  }

  async removeTripItem(tripId: string, itemIndex: number): Promise<void> {
    const trip = await this.loadTrip(tripId);
    const items = tripItemsFromRecord(trip);
    if (itemIndex < 0 || itemIndex >= items.length) {
      throw new Error(`removeTripItem: index ${itemIndex} out of range (0..${items.length - 1})`);
    }
    const nextItems = items.filter((_, i) => i !== itemIndex);
    await this.wpb.collection("shopping_trips").update(tripId, { items: nextItems });
  }

  /**
   * Load a trip record, preferring the optimistic view so a still-pending
   * edit on the same trip is visible without a server round-trip. Same
   * pattern as the old `upsertHistory` race fix (commit 21878cc); race
   * pressure is lower on trips (low-traffic, single-user-edits) but the
   * cost of using the pattern is negligible and it keeps surgical-op
   * read-modify-write correct under back-to-back edits.
   */
  private async loadTrip(tripId: string): Promise<RecordModel> {
    const fromView = this.wpb.collection("shopping_trips").viewCollection<RecordModel>(
      (r) => r.id === tripId,
    );
    if (fromView.length > 0) return fromView[0];
    return this.pb().collection("shopping_trips").getOne(tripId, { $autoCancel: false });
  }

  /**
   * Subscribe to all shopping data for a list via the mirror.
   *
   * Three declarative slice descriptions (list / items / trips) plus a
   * tear-down — the mirror handles ref-counted SSE coalescing, optimistic
   * overlay, sort+limit refetches, and synchronous teardown that's safe
   * before initial state lands. Every cancel-before-resolve concern lives
   * in the mirror; see mirror.test.ts for the exhaustive coverage.
   */
  subscribeToList(
    listId: string,
    handlers: {
      onList: (list: ShoppingList) => void;
      onItems: (items: ShoppingItem[]) => void;
      onTrips: (trips: ShoppingTrip[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe {
    // Track whether we've ever observed the list existing. An initial 404
    // is "doesn't exist yet" (don't fire onDeleted); a transition from
    // exists → empty after we've seen it is "deleted."
    let listKnownExisted = false;

    const listHandle = this.mirror.watch(
      { collection: "shopping_lists", topic: listId },
      (records) => {
        if (records.length === 0) {
          if (listKnownExisted) handlers.onDeleted?.();
          return;
        }
        listKnownExisted = true;
        handlers.onList(listFromRecord(records[0]));
      },
    );

    const itemsHandle = this.mirror.watch(
      {
        collection: "shopping_items",
        topic: "*",
        filter: this.pb().filter("list = {:listId}", { listId }),
        predicate: (r) => r.list === listId,
      },
      (records) => {
        handlers.onItems(records.map(itemFromRecord));
      },
    );

    const tripsHandle = this.mirror.watch(
      {
        collection: "shopping_trips",
        topic: "*",
        filter: this.pb().filter("list = {:listId}", { listId }),
        sort: "-completed_at",
        limit: TRIPS_PAGE_SIZE,
        predicate: (r) => r.list === listId,
      },
      (records) => {
        handlers.onTrips(records.map(tripFromRecord));
      },
    );

    return () => {
      listHandle.unsubscribe();
      itemsHandle.unsubscribe();
      tripsHandle.unsubscribe();
    };
  }
}
