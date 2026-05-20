/**
 * PocketBase implementation of ShoppingBackend.
 *
 * Writes route through the optimistic wrapper (wrapPocketBase) so the UI
 * sees changes within a frame. Reads on every collection go through PBMirror
 * — one centralized subscription engine that handles cancel-before-resolve,
 * SSE coalescing, mutation-queue overlay, and full-state delivery. This file
 * is the first backend to adopt the mirror; the others migrate in follow-up
 * PRs (see `packages/backend/src/wrapped-pb/mirror.ts`).
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { ShoppingBackend } from "../interfaces/shopping";
import type { ShoppingList, ShoppingItem, CategoryDef, HistoryEntry, ShoppingTrip } from "../types/shopping";
import type { Unsubscribe } from "../types/common";
import { newId } from "../cache/ids";
import type { WrappedPocketBase } from "../wrapped-pb";
import type { PBMirror, RawRecord } from "../wrapped-pb/mirror";

// --- Pagination limits ---

const HISTORY_PAGE_SIZE = 500;
const TRIPS_PAGE_SIZE = 50;

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

function historyFromRecord(r: RecordModel | RawRecord): HistoryEntry {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    ingredient: (x.ingredient as string) || "",
    categoryId: (x.category_id as string) || "uncategorized",
    lastAdded: new Date(x.last_added as string),
  };
}

function tripFromRecord(r: RecordModel | RawRecord): ShoppingTrip {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    list: x.list as string,
    completedAt: new Date(x.completed_at as string),
    items: ((x.items as Array<Record<string, string>>) || []).map((item) => ({
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

  /** Upsert a history entry — find existing by (list, ingredient) and update, else create.
   *
   * The optimistic-view check must come first. Reading through the live PB
   * here (this.pb().getFirstListItem) used to race when a user added an
   * item and re-categorized it within ~5s: the second upsert's read fired
   * before the first upsert's create had committed to the server, so it
   * saw "no row" and created a duplicate. Checking the wpb view first
   * means a still-pending create is visible and we update it in place.
   */
  private async upsertHistory(
    listId: string,
    ingredient: string,
    categoryId: string,
  ): Promise<void> {
    const normalized = normalizeIngredient(ingredient);

    const fromQueue = this.wpb.collection("shopping_history").viewCollection<RecordModel>(
      (r) => r.list === listId && r.ingredient === normalized,
    );
    if (fromQueue.length > 0) {
      await this.wpb.collection("shopping_history").update(fromQueue[0].id, {
        category_id: categoryId,
        last_added: new Date().toISOString(),
      });
      return;
    }

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

  /**
   * Subscribe to all shopping data for a list via the mirror.
   *
   * Replaces the prior bespoke implementation that ran four separate
   * `wpb.subscribe` / `pb.subscribe` chains, each with its own
   * cancelled-flag bookkeeping, `trackUnsub` helper, and `itemsMap`
   * delta-buffering. All of that lived to work around the underlying
   * async-unsubscribe + delta-event-stream APIs; the mirror inverts both
   * concerns (synchronous teardown, full-state delivery) so the backend
   * code becomes four declarative slice descriptions plus a tear-down.
   *
   * The mirror's `WatchHandle.unsubscribe()` is synchronous and safe at
   * any time (including before initial state lands), so we no longer need
   * `cancelled` flags or `trackUnsub`. Every cancel-before-resolve fix
   * we made here lives in the mirror now, exercised by mirror.test.ts.
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

    const historyHandle = this.mirror.watch(
      {
        collection: "shopping_history",
        topic: "*",
        filter: this.pb().filter("list = {:listId}", { listId }),
        sort: "-last_added",
        limit: HISTORY_PAGE_SIZE,
        predicate: (r) => r.list === listId,
      },
      (records) => {
        handlers.onHistory(records.map(historyFromRecord));
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
      historyHandle.unsubscribe();
      tripsHandle.unsubscribe();
    };
  }
}
