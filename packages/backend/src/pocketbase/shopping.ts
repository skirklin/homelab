/**
 * PocketBase implementation of ShoppingBackend.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { ShoppingBackend } from "../interfaces/shopping";
import type { ShoppingList, ShoppingItem, CategoryDef, HistoryEntry, ShoppingTrip } from "../types/shopping";
import type { Unsubscribe } from "../types/common";

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
  constructor(private pb: () => PocketBase) {}

  async createList(name: string, userId: string): Promise<string> {
    const list = await this.pb().collection("shopping_lists").create({
      name,
      owners: [userId],
      category_defs: [],
    }, { $autoCancel: false });
    return list.id;
  }

  async renameList(listId: string, name: string): Promise<void> {
    await this.pb().collection("shopping_lists").update(listId, { name });
  }

  async deleteList(listId: string): Promise<void> {
    await this.pb().collection("shopping_lists").delete(listId);
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
    await this.pb().collection("shopping_lists").update(listId, {
      category_defs: categories,
    });
  }

  async addItem(
    listId: string,
    ingredient: string,
    userId: string,
    options?: { categoryId?: string; note?: string },
  ): Promise<string> {
    const opts = { $autoCancel: false };
    let categoryId = options?.categoryId || "uncategorized";

    if (!options?.categoryId) {
      try {
        const history = await this.pb().collection("shopping_history").getFirstListItem(
          this.pb().filter("list = {:listId} && ingredient = {:ingredient}", { listId, ingredient: normalizeIngredient(ingredient) }),
          opts,
        );
        categoryId = history.category_id || "uncategorized";
      } catch {
        // No history found
      }
    }

    const item = await this.pb().collection("shopping_items").create({
      list: listId,
      ingredient,
      note: options?.note || "",
      category_id: categoryId,
      checked: false,
      added_by: userId,
    }, opts);

    // Save to history
    try {
      const existing = await this.pb().collection("shopping_history").getFirstListItem(
        this.pb().filter("list = {:listId} && ingredient = {:ingredient}", { listId, ingredient: normalizeIngredient(ingredient) }),
        opts,
      );
      await this.pb().collection("shopping_history").update(existing.id, {
        category_id: categoryId,
        last_added: new Date().toISOString(),
      }, opts);
    } catch {
      await this.pb().collection("shopping_history").create({
        list: listId,
        ingredient: normalizeIngredient(ingredient),
        category_id: categoryId,
        last_added: new Date().toISOString(),
      }, opts);
    }

    return item.id;
  }

  async updateItem(itemId: string, updates: { ingredient?: string; note?: string }): Promise<void> {
    const data: Record<string, string> = {};
    if (updates.ingredient !== undefined) data.ingredient = updates.ingredient;
    if (updates.note !== undefined) data.note = updates.note || "";
    await this.pb().collection("shopping_items").update(itemId, data);
  }

  async updateItemCategory(itemId: string, categoryId: string, ingredient: string): Promise<void> {
    await this.pb().collection("shopping_items").update(itemId, { category_id: categoryId });

    // Update history
    // We need the list ID — get it from the item record
    const item = await this.pb().collection("shopping_items").getOne(itemId);
    const listId = item.list;
    try {
      const existing = await this.pb().collection("shopping_history").getFirstListItem(
        this.pb().filter("list = {:listId} && ingredient = {:ingredient}", { listId, ingredient: normalizeIngredient(ingredient) }),
      );
      await this.pb().collection("shopping_history").update(existing.id, {
        category_id: categoryId,
        last_added: new Date().toISOString(),
      });
    } catch {
      await this.pb().collection("shopping_history").create({
        list: listId,
        ingredient: normalizeIngredient(ingredient),
        category_id: categoryId,
        last_added: new Date().toISOString(),
      });
    }
  }

  async toggleItem(itemId: string, checked: boolean, userId: string): Promise<void> {
    if (checked) {
      await this.pb().collection("shopping_items").update(itemId, {
        checked: true,
        checked_by: userId,
        checked_at: new Date().toISOString(),
      });
    } else {
      await this.pb().collection("shopping_items").update(itemId, {
        checked: false,
        checked_by: "",
        checked_at: "",
      });
    }
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.pb().collection("shopping_items").delete(itemId);
  }

  async clearCheckedItems(
    listId: string,
    items: Pick<ShoppingItem, "id" | "ingredient" | "note" | "categoryId" | "checked">[],
  ): Promise<void> {
    const checkedItems = items.filter((item) => item.checked);
    if (checkedItems.length === 0) return;

    await this.pb().collection("shopping_trips").create({
      list: listId,
      completed_at: new Date().toISOString(),
      items: checkedItems.map((item) => ({
        ingredient: item.ingredient,
        ...(item.note ? { note: item.note } : {}),
        categoryId: item.categoryId,
      })),
    });

    await Promise.all(
      checkedItems.map((item) => this.pb().collection("shopping_items").delete(item.id)),
    );
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

    // We track items in a map so we can deliver full state on each change
    const itemsMap = new Map<string, ShoppingItem>();

    const emitItems = () => {
      if (!cancelled) handlers.onItems(Array.from(itemsMap.values()));
    };

    // List metadata
    this.subscribeToRecord("shopping_lists", listId, isCancelled, {
      onData: (r) => handlers.onList(listFromRecord(r)),
      onDelete: () => handlers.onDeleted?.(),
    }).then((u) => unsubs.push(u));

    // Items — track in map, emit full state
    this.subscribeToCollection("shopping_items", isCancelled, {
      filter: this.pb().filter("list = {:listId}", { listId }),
      belongsTo: (r) => r.list === listId,
      onInitial: (records) => {
        for (const r of records) itemsMap.set(r.id, itemFromRecord(r));
        emitItems();
      },
      onChange: (action, r) => {
        if (action === "delete") {
          itemsMap.delete(r.id);
        } else {
          itemsMap.set(r.id, itemFromRecord(r));
        }
        emitItems();
      },
    }).then((u) => unsubs.push(u));

    // History — full reload on any change
    this.subscribeToCollectionReload("shopping_history", isCancelled, {
      filter: this.pb().filter("list = {:listId}", { listId }),
      sort: "-last_added",
      perPage: HISTORY_PAGE_SIZE,
      belongsTo: (r) => r.list === listId,
      onData: (records) => handlers.onHistory(records.map(historyFromRecord)),
    }).then((u) => unsubs.push(u));

    // Trips — full reload on any change
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

  // --- Internal subscription helpers (wrapping PocketBase realtime) ---

  private async subscribeToRecord(
    collection: string,
    id: string,
    cancelled: () => boolean,
    callbacks: { onData: (r: RecordModel) => void; onDelete?: () => void },
  ): Promise<() => void> {
    // Fetch initial
    try {
      const record = await this.pb().collection(collection).getOne(id, { $autoCancel: false });
      if (!cancelled()) callbacks.onData(record);
    } catch {
      // Record not found
    }

    // Subscribe to changes
    const unsub = await this.pb().collection(collection).subscribe(id, (e) => {
      if (cancelled()) return;
      if (e.action === "delete") {
        callbacks.onDelete?.();
      } else {
        callbacks.onData(e.record);
      }
    });

    return unsub;
  }

  private async subscribeToCollection(
    collection: string,
    cancelled: () => boolean,
    options: {
      filter: string;
      belongsTo: (r: RecordModel) => boolean;
      onInitial: (records: RecordModel[]) => void;
      onChange: (action: "create" | "update" | "delete", r: RecordModel) => void;
    },
  ): Promise<() => void> {
    // Fetch initial
    try {
      const records = await this.pb().collection(collection).getFullList({
        filter: options.filter,
        $autoCancel: false,
      });
      if (!cancelled()) options.onInitial(records);
    } catch (e) {
      if (!cancelled()) console.warn(`[shopping] subCol ${collection} failed`, e);
    }

    // Subscribe to changes
    const unsub = await this.pb().collection(collection).subscribe("*", (e) => {
      if (cancelled() || !options.belongsTo(e.record)) return;
      options.onChange(e.action as "create" | "update" | "delete", e.record);
    });

    return unsub;
  }

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

    // Initial load
    await reload();

    // Reload on any change
    const unsub = await this.pb().collection(collection).subscribe("*", (e) => {
      if (cancelled() || !options.belongsTo(e.record)) return;
      reload();
    });

    return unsub;
  }
}
