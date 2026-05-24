/**
 * PocketBase implementation of ShoppingBackend.
 *
 * Writes route through the optimistic wrapper (wrapPocketBase) so the UI
 * sees changes within a frame. Reads on trips stay direct because that
 * collection is write-once-read-many and doesn't need optimistic UI.
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
import { newId } from "../cache/ids";
import type { WrappedPocketBase } from "../wrapped-pb";

// --- Pagination limits ---

const TRIPS_PAGE_SIZE = 50;

// --- Record → domain type mappers ---

function listFromRecord(r: RecordModel): ShoppingList {
  return {
    id: r.id,
    name: r.name || "",
    owners: Array.isArray(r.owners) ? r.owners : [],
    categories: Array.isArray(r.category_defs) ? r.category_defs : [],
    created: r.created,
    updated: r.updated,
  };
}

function itemFromRecord(r: RecordModel): ShoppingItem {
  return {
    id: r.id,
    list: r.list,
    ingredient: r.ingredient || "",
    note: r.note || "",
    categoryId: r.category_id || "uncategorized",
    checked: !!r.checked,
    checkedBy: r.checked_by || undefined,
    checkedAt: r.checked_at || undefined,
    addedBy: r.added_by || undefined,
    addedAt: r.created,
    created: r.created,
    updated: r.updated,
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

function tripItemsFromRecord(r: RecordModel): TripItemRaw[] {
  return Array.isArray(r.items) ? r.items : [];
}

function tripFromRecord(r: RecordModel): ShoppingTrip {
  return {
    id: r.id,
    list: r.list,
    completedAt: new Date(r.completed_at),
    items: tripItemsFromRecord(r).map((item) => ({
      ingredient: item.ingredient || item.name || "",
      note: item.note || "",
      categoryId: item.categoryId || "uncategorized",
    })),
  };
}

export class PocketBaseShoppingBackend implements ShoppingBackend {
  private wpb: WrappedPocketBase;

  constructor(private pb: () => PocketBase, wpb: WrappedPocketBase) {
    this.wpb = wpb;
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
      ingredient,
      note: note || "",
      category_id: categoryId,
      checked: false,
      added_by: userId,
    }, { $autoCancel: false });
    return itemId;
  }

  async updateItem(itemId: string, updates: { ingredient?: string; note?: string }): Promise<void> {
    const data: Record<string, string> = {};
    if (updates.ingredient !== undefined) data.ingredient = updates.ingredient;
    if (updates.note !== undefined) data.note = updates.note || "";
    await this.wpb.collection("shopping_items").update(itemId, data);
  }

  async updateItemCategory(
    itemId: string,
    _listId: string,
    categoryId: string,
    _ingredient: string,
  ): Promise<void> {
    // listId + ingredient are kept in the signature for parity with addItem;
    // they were only needed for the now-retired history upsert.
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
    if (patch.ingredient !== undefined && !patch.ingredient.trim()) {
      throw new Error("updateTripItem: ingredient cannot be empty");
    }
    const nextItems = items.map((item, i) => {
      if (i !== itemIndex) return item;
      const next: TripItemRaw = { ...item };
      if (patch.ingredient !== undefined) next.ingredient = patch.ingredient.trim();
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

  subscribeToList(
    listId: string,
    handlers: {
      onList: (list: ShoppingList) => void;
      onItems: (items: ShoppingItem[]) => void;
      onTrips: (trips: ShoppingTrip[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe {
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    const isCancelled = () => cancelled;

    // Cancel-before-resolve guard: each inner subscribe(...).then(u =>
    // unsubs.push(u)) chain is async, so if the consumer tears down before
    // any of those .then callbacks land, the unsubs array is empty when the
    // returned cleanup runs — and the underlying pb realtime subscriptions
    // leak forever. Route every late-arriving unsub through this helper so
    // a teardown that ran first still tears down the late-resolved sub. Same
    // shape as subscribeSlugs / recipes / life / upkeep fixes.
    const trackUnsub = (p: Promise<() => void>) => {
      p.then((u) => {
        if (cancelled) {
          try { u(); } catch { /* nothing to do */ }
        } else {
          unsubs.push(u);
        }
      }).catch(() => { /* upstream errors are surfaced elsewhere */ });
    };

    // We track items in a map so we can deliver full state on each change.
    const itemsMap = new Map<string, ShoppingItem>();

    const emitItems = () => {
      if (!cancelled) handlers.onItems(Array.from(itemsMap.values()));
    };

    // List metadata — wpb.subscribe(id) auto-loads + delivers initial state
    // as a "create" event, then forwards live updates.
    trackUnsub(this.wpb.collection("shopping_lists").subscribe(listId, (e) => {
      if (cancelled) return;
      if (e.action === "delete") {
        handlers.onDeleted?.();
      } else {
        handlers.onList(listFromRecord(e.record));
      }
    }));

    // Items — wpb.subscribe("*", { filter }) auto-loads matching records,
    // seeds the optimistic queue, and delivers each as a "create" event,
    // then forwards live create/update/delete. We buffer initial creates
    // into itemsMap and emit a single onItems batch once the subscribe
    // promise resolves; subsequent live events emit per-change.
    let itemsInitialDone = false;
    const itemsPromise = this.wpb.collection("shopping_items").subscribe("*", (e) => {
      if (cancelled || (e.record as RecordModel).list !== listId) return;
      if (e.action === "delete") {
        itemsMap.delete(e.record.id);
      } else {
        itemsMap.set(e.record.id, itemFromRecord(e.record));
      }
      if (itemsInitialDone) emitItems();
    }, {
      filter: this.pb().filter("list = {:listId}", { listId }),
      local: (r) => r.list === listId,
    });
    trackUnsub(itemsPromise);
    itemsPromise.then(() => {
      if (!cancelled) {
        itemsInitialDone = true;
        emitItems();
      }
    }).catch(() => { /* surfaced via wpb's error channel */ });

    // Trips — full reload on any change.
    trackUnsub(this.subscribeToCollectionReload("shopping_trips", isCancelled, {
      filter: this.pb().filter("list = {:listId}", { listId }),
      sort: "-completed_at",
      perPage: TRIPS_PAGE_SIZE,
      belongsTo: (r) => r.list === listId,
      onData: (records) => handlers.onTrips(records.map(tripFromRecord)),
    }));

    return () => {
      cancelled = true;
      unsubs.forEach((u) => {
        try { u(); } catch { /* nothing to do */ }
      });
    };
  }

  // --- Internal subscription helpers ---

  /**
   * Subscribe to a collection that fully reloads on any change. Used for
   * trips where ordering and pagination matter more than per-record deltas.
   * Stays on raw pb.subscribe — writes go through wpb so the server event
   * we receive already reflects ack'd state.
   */
  private async subscribeToCollectionReload(
    collection: string,
    cancelled: () => boolean,
    options: {
      filter: string;
      sort: string;
      perPage: number;
      belongsTo: (r: RecordModel) => boolean;
      onData: (records: RecordModel[]) => void;
    },
  ): Promise<() => void> {
    const reload = async () => {
      try {
        const result = await this.pb().collection(collection).getList(1, options.perPage, {
          filter: options.filter,
          sort: options.sort,
          $autoCancel: false,
        });
        if (!cancelled()) options.onData(result.items);
      } catch {
        if (!cancelled()) options.onData([]);
      }
    };

    await reload();

    // Defense-in-depth alongside the outer trackUnsub wrapper: if the caller
    // tore down between `await reload()` and here, short-circuit so we never
    // open a pb realtime subscription only to immediately tear it back down.
    // trackUnsub still catches the leak if cancellation lands during the
    // subscribe() await below — this just avoids the wasted round-trip.
    if (cancelled()) return () => {};

    const unsub = await this.pb().collection(collection).subscribe("*", (e) => {
      if (cancelled() || !options.belongsTo(e.record)) return;
      reload();
    });

    return unsub;
  }
}
