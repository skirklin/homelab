/**
 * PocketBase implementation of ShoppingBackend.
 *
 * Writes route through the optimistic wrapper (wrapPocketBase) so the UI
 * sees changes within a frame. Reads on history/trips stay direct because
 * those collections are write-once-read-many and don't need optimistic UI.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { ShoppingBackend } from "../interfaces/shopping";
import type { ShoppingList, ShoppingItem, CategoryDef, HistoryEntry, ShoppingTrip } from "../types/shopping";
import type { Unsubscribe } from "../types/common";
import { newId } from "../cache/ids";
import { wrapPocketBase, type WrappedPocketBase } from "../wrapped-pb";

// --- Pagination limits ---

const HISTORY_PAGE_SIZE = 500;
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

function historyFromRecord(r: RecordModel): HistoryEntry {
  return {
    id: r.id,
    ingredient: r.ingredient || "",
    categoryId: r.category_id || "uncategorized",
    lastAdded: new Date(r.last_added),
  };
}

function tripFromRecord(r: RecordModel): ShoppingTrip {
  return {
    id: r.id,
    list: r.list,
    completedAt: new Date(r.completed_at),
    items: (r.items || []).map((item: Record<string, string>) => ({
      ingredient: item.ingredient || item.name || "",
      note: item.note || "",
      categoryId: item.categoryId || "uncategorized",
    })),
  };
}

function normalizeIngredient(ingredient: string): string {
  return ingredient.toLowerCase().trim();
}

export class PocketBaseShoppingBackend implements ShoppingBackend {
  private wpb: WrappedPocketBase;

  constructor(private pb: () => PocketBase, wpb?: WrappedPocketBase) {
    this.wpb = wpb ?? wrapPocketBase(pb);
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
    // Both writes go optimistic via wpb; awaiting both ensures sequencing for
    // callers (e.g. updateItemCategory immediately after addItem) sees the
    // history row already in place.
    await Promise.all([
      this.wpb.collection("shopping_items").create({
        id: itemId,
        list: listId,
        ingredient,
        note: note || "",
        category_id: categoryId,
        checked: false,
        added_by: userId,
      }, { $autoCancel: false }),
      this.upsertHistory(listId, ingredient, categoryId),
    ]);
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
    listId: string,
    categoryId: string,
    ingredient: string,
  ): Promise<void> {
    await this.wpb.collection("shopping_items").update(itemId, { category_id: categoryId });
    await this.upsertHistory(listId, ingredient, categoryId);
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

  /** Upsert a history entry — find existing by (list, ingredient) and update, else create. */
  private async upsertHistory(
    listId: string,
    ingredient: string,
    categoryId: string,
  ): Promise<void> {
    const normalized = normalizeIngredient(ingredient);
    const filter = this.pb().filter(
      "list = {:listId} && ingredient = {:ingredient}",
      { listId, ingredient: normalized },
    );
    try {
      const existing = await this.pb().collection("shopping_history").getFirstListItem(
        filter,
        { $autoCancel: false },
      );
      await this.wpb.collection("shopping_history").update(existing.id, {
        category_id: categoryId,
        last_added: new Date().toISOString(),
      });
    } catch {
      await this.wpb.collection("shopping_history").create({
        id: newId(),
        list: listId,
        ingredient: normalized,
        category_id: categoryId,
        last_added: new Date().toISOString(),
      });
    }
  }

  subscribeToList(
    listId: string,
    handlers: {
      onList: (list: ShoppingList) => void;
      onItems: (items: ShoppingItem[]) => void;
      onHistory: (entries: HistoryEntry[]) => void;
      onTrips: (trips: ShoppingTrip[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe {
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    const isCancelled = () => cancelled;

    // We track items in a map so we can deliver full state on each change.
    const itemsMap = new Map<string, ShoppingItem>();

    const emitItems = () => {
      if (!cancelled) handlers.onItems(Array.from(itemsMap.values()));
    };

    // List metadata — wpb.subscribe(id) auto-loads + delivers initial state
    // as a "create" event, then forwards live updates.
    this.wpb.collection("shopping_lists").subscribe(listId, (e) => {
      if (cancelled) return;
      if (e.action === "delete") {
        handlers.onDeleted?.();
      } else {
        handlers.onList(listFromRecord(e.record));
      }
    }).then((u) => unsubs.push(u));

    // Items — wpb.subscribe("*", { filter }) auto-loads matching records,
    // seeds the optimistic queue, and delivers each as a "create" event,
    // then forwards live create/update/delete. We buffer initial creates
    // into itemsMap and emit a single onItems batch once the subscribe
    // promise resolves; subsequent live events emit per-change.
    let itemsInitialDone = false;
    this.wpb.collection("shopping_items").subscribe("*", (e) => {
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
    }).then((u) => {
      unsubs.push(u);
      if (!cancelled) {
        itemsInitialDone = true;
        emitItems();
      }
    });

    // History — full reload on any change. Stays on raw pb subscribe; writes
    // still go through wpb so persistence + replay-on-reload work.
    this.subscribeToCollectionReload("shopping_history", isCancelled, {
      filter: this.pb().filter("list = {:listId}", { listId }),
      sort: "-last_added",
      perPage: HISTORY_PAGE_SIZE,
      belongsTo: (r) => r.list === listId,
      onData: (records) => handlers.onHistory(records.map(historyFromRecord)),
    }).then((u) => unsubs.push(u));

    // Trips — full reload on any change.
    this.subscribeToCollectionReload("shopping_trips", isCancelled, {
      filter: this.pb().filter("list = {:listId}", { listId }),
      sort: "-completed_at",
      perPage: TRIPS_PAGE_SIZE,
      belongsTo: (r) => r.list === listId,
      onData: (records) => handlers.onTrips(records.map(tripFromRecord)),
    }).then((u) => unsubs.push(u));

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }

  // --- Internal subscription helpers ---

  /**
   * Subscribe to a collection that fully reloads on any change. Used for
   * history/trips where ordering and pagination matter more than per-record
   * deltas. Stays on raw pb.subscribe — writes go through wpb so the server
   * event we receive already reflects ack'd state.
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

    const unsub = await this.pb().collection(collection).subscribe("*", (e) => {
      if (cancelled() || !options.belongsTo(e.record)) return;
      reload();
    });

    return unsub;
  }
}
