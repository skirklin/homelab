/**
 * Supabase implementation of ShoppingBackend.
 *
 * Translates the same surface PocketBaseShoppingBackend exposes onto
 * Postgres tables + RLS + Supabase Realtime channels. No optimistic write
 * wrapper yet — Phase 3 first cut. The PB version uses `wpb` for sub-frame
 * write echoes; a Supabase-flavored equivalent is a Phase 3 follow-up.
 *
 * Subscription model mirrors the PB shape:
 *   - List metadata: re-fetch on any change (need owners join)
 *   - Items: per-record map, emit full state on each delta
 *   - History: full reload on any change (order + page)
 *   - Trips: full reload on any change
 *
 * Initial state is loaded AFTER the realtime channel reaches the
 * SUBSCRIBED state to avoid the race where an insert lands between the
 * subscribe call and the channel actually attaching.
 */
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { ShoppingBackend } from "../interfaces/shopping";
import type {
  ShoppingList,
  ShoppingItem,
  CategoryDef,
  HistoryEntry,
  ShoppingTrip,
} from "../types/shopping";
import type { Unsubscribe } from "../types/common";

// ---- Page sizes ---------------------------------------------------------

const HISTORY_PAGE_SIZE = 500;
const TRIPS_PAGE_SIZE = 50;

// ---- Postgres row shapes ------------------------------------------------

interface ListRow {
  id: string;
  name: string;
  category_defs: CategoryDef[] | null;
  created_at: string;
  updated_at: string;
  shopping_list_owners?: Array<{ user_id: string }>;
}

interface ItemRow {
  id: string;
  list_id: string;
  ingredient: string;
  note: string | null;
  category_id: string | null;
  checked: boolean;
  added_by: string | null;
  checked_by: string | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface HistoryRow {
  id: string;
  list_id: string;
  ingredient: string;
  category_id: string | null;
  last_added: string | null;
}

interface TripRow {
  id: string;
  list_id: string;
  completed_at: string;
  items: Array<{ ingredient: string; note?: string; categoryId?: string }> | null;
}

// ---- Row → domain mappers ----------------------------------------------

function listFromRow(r: ListRow): ShoppingList {
  return {
    id: r.id,
    name: r.name,
    owners: r.shopping_list_owners?.map((o) => o.user_id) ?? [],
    categories: r.category_defs ?? [],
    created: r.created_at,
    updated: r.updated_at,
  };
}

function itemFromRow(r: ItemRow): ShoppingItem {
  return {
    id: r.id,
    list: r.list_id,
    ingredient: r.ingredient,
    note: r.note ?? "",
    categoryId: r.category_id ?? "uncategorized",
    checked: r.checked,
    addedBy: r.added_by ?? undefined,
    checkedBy: r.checked_by ?? undefined,
    checkedAt: r.checked_at ?? undefined,
    addedAt: r.created_at,
    created: r.created_at,
    updated: r.updated_at,
  };
}

function historyFromRow(r: HistoryRow): HistoryEntry {
  return {
    id: r.id,
    ingredient: r.ingredient,
    categoryId: r.category_id ?? "uncategorized",
    lastAdded: r.last_added ? new Date(r.last_added) : new Date(0),
  };
}

function tripFromRow(r: TripRow): ShoppingTrip {
  return {
    id: r.id,
    list: r.list_id,
    completedAt: new Date(r.completed_at),
    items: (r.items ?? []).map((i) => ({
      ingredient: i.ingredient,
      note: i.note ?? "",
      categoryId: i.categoryId ?? "uncategorized",
    })),
  };
}

function normalizeIngredient(s: string): string {
  return s.toLowerCase().trim();
}

// ---- Backend implementation --------------------------------------------

export class SupabaseShoppingBackend implements ShoppingBackend {
  constructor(private client: SupabaseClient) {}

  async createList(name: string, userId: string): Promise<string> {
    // Two-step: insert list, then owner row. No Postgres transaction
    // available over PostgREST without an RPC; if owner insert fails we
    // best-effort cleanup the orphan list.
    const { data: list, error: listErr } = await this.client
      .from("shopping_lists")
      .insert({ name, category_defs: [] })
      .select("id")
      .single();
    if (listErr) throw listErr;

    const { error: ownerErr } = await this.client
      .from("shopping_list_owners")
      .insert({ list_id: list.id, user_id: userId });
    if (ownerErr) {
      await this.client.from("shopping_lists").delete().eq("id", list.id);
      throw ownerErr;
    }
    return list.id;
  }

  async renameList(listId: string, name: string): Promise<void> {
    const { error } = await this.client
      .from("shopping_lists")
      .update({ name })
      .eq("id", listId);
    if (error) throw error;
  }

  async deleteList(listId: string): Promise<void> {
    const { error } = await this.client.from("shopping_lists").delete().eq("id", listId);
    if (error) throw error;
  }

  async getList(listId: string): Promise<ShoppingList | null> {
    return this.loadListMeta(listId);
  }

  async updateCategories(listId: string, categories: CategoryDef[]): Promise<void> {
    const { error } = await this.client
      .from("shopping_lists")
      .update({ category_defs: categories })
      .eq("id", listId);
    if (error) throw error;
  }

  async addItem(
    listId: string,
    ingredient: string,
    userId: string,
    categoryId: string,
    note?: string,
  ): Promise<string> {
    const { data: item, error: itemErr } = await this.client
      .from("shopping_items")
      .insert({
        list_id: listId,
        ingredient,
        note: note ?? "",
        category_id: categoryId,
        checked: false,
        added_by: userId,
      })
      .select("id")
      .single();
    if (itemErr) throw itemErr;

    await this.upsertHistory(listId, ingredient, categoryId);
    return item.id;
  }

  async updateItem(
    itemId: string,
    updates: { ingredient?: string; note?: string },
  ): Promise<void> {
    const patch: Record<string, string> = {};
    if (updates.ingredient !== undefined) patch.ingredient = updates.ingredient;
    if (updates.note !== undefined) patch.note = updates.note;
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.client
      .from("shopping_items")
      .update(patch)
      .eq("id", itemId);
    if (error) throw error;
  }

  async updateItemCategory(
    itemId: string,
    listId: string,
    categoryId: string,
    ingredient: string,
  ): Promise<void> {
    const { error } = await this.client
      .from("shopping_items")
      .update({ category_id: categoryId })
      .eq("id", itemId);
    if (error) throw error;
    await this.upsertHistory(listId, ingredient, categoryId);
  }

  async toggleItem(itemId: string, checked: boolean, userId: string): Promise<void> {
    const patch: Record<string, unknown> = checked
      ? { checked: true, checked_by: userId, checked_at: new Date().toISOString() }
      : { checked: false, checked_by: null, checked_at: null };
    const { error } = await this.client
      .from("shopping_items")
      .update(patch)
      .eq("id", itemId);
    if (error) throw error;
  }

  async deleteItem(itemId: string): Promise<void> {
    const { error } = await this.client.from("shopping_items").delete().eq("id", itemId);
    if (error) throw error;
  }

  async clearCheckedItems(
    listId: string,
    items: Pick<ShoppingItem, "id" | "ingredient" | "note" | "categoryId" | "checked">[],
  ): Promise<void> {
    const checkedItems = items.filter((it) => it.checked);
    if (checkedItems.length === 0) return;

    const { error: tripErr } = await this.client.from("shopping_trips").insert({
      list_id: listId,
      completed_at: new Date().toISOString(),
      items: checkedItems.map((it) => ({
        ingredient: it.ingredient,
        ...(it.note ? { note: it.note } : {}),
        categoryId: it.categoryId,
      })),
    });
    if (tripErr) throw tripErr;

    const { error: delErr } = await this.client
      .from("shopping_items")
      .delete()
      .in(
        "id",
        checkedItems.map((it) => it.id),
      );
    if (delErr) throw delErr;
  }

  private async upsertHistory(
    listId: string,
    ingredient: string,
    categoryId: string,
  ): Promise<void> {
    // Relies on UNIQUE (list_id, ingredient) in schema.sql.
    const { error } = await this.client.from("shopping_history").upsert(
      {
        list_id: listId,
        ingredient: normalizeIngredient(ingredient),
        category_id: categoryId,
        last_added: new Date().toISOString(),
      },
      { onConflict: "list_id,ingredient" },
    );
    if (error) throw error;
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
    const itemsMap = new Map<string, ShoppingItem>();

    const emitItems = () => {
      if (!cancelled) handlers.onItems(Array.from(itemsMap.values()));
    };

    const reloadList = () =>
      this.loadListMeta(listId).then((l) => {
        if (!cancelled && l) handlers.onList(l);
      });
    const reloadHistory = () =>
      this.loadHistory(listId).then((h) => {
        if (!cancelled) handlers.onHistory(h);
      });
    const reloadTrips = () =>
      this.loadTrips(listId).then((t) => {
        if (!cancelled) handlers.onTrips(t);
      });

    const channel: RealtimeChannel = this.client
      .channel(`shopping-list-${listId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "shopping_lists", filter: `id=eq.${listId}` },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") {
            handlers.onDeleted?.();
          } else {
            void reloadList();
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "shopping_items",
          filter: `list_id=eq.${listId}`,
        },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<ItemRow>;
            if (old.id) itemsMap.delete(old.id);
          } else {
            const row = payload.new as ItemRow;
            itemsMap.set(row.id, itemFromRow(row));
          }
          emitItems();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "shopping_history",
          filter: `list_id=eq.${listId}`,
        },
        () => {
          if (!cancelled) void reloadHistory();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "shopping_trips",
          filter: `list_id=eq.${listId}`,
        },
        () => {
          if (!cancelled) void reloadTrips();
        },
      )
      .subscribe(async (status) => {
        // Load initial state ONLY after the channel is live, so any insert
        // that happens between subscribe() and SUBSCRIBED is still delivered.
        if (status !== "SUBSCRIBED" || cancelled) return;
        const items = await this.loadItems(listId);
        if (cancelled) return;
        itemsMap.clear();
        for (const it of items) itemsMap.set(it.id, it);
        emitItems();
        await Promise.all([reloadList(), reloadHistory(), reloadTrips()]);
      });

    return () => {
      cancelled = true;
      void this.client.removeChannel(channel);
    };
  }

  // ---- Loaders -----------------------------------------------------------

  private async loadListMeta(listId: string): Promise<ShoppingList | null> {
    const { data, error } = await this.client
      .from("shopping_lists")
      .select("*, shopping_list_owners(user_id)")
      .eq("id", listId)
      .maybeSingle();
    if (error || !data) return null;
    return listFromRow(data as ListRow);
  }

  private async loadItems(listId: string): Promise<ShoppingItem[]> {
    const { data, error } = await this.client
      .from("shopping_items")
      .select("*")
      .eq("list_id", listId);
    if (error || !data) return [];
    return (data as ItemRow[]).map(itemFromRow);
  }

  private async loadHistory(listId: string): Promise<HistoryEntry[]> {
    const { data, error } = await this.client
      .from("shopping_history")
      .select("*")
      .eq("list_id", listId)
      .order("last_added", { ascending: false })
      .limit(HISTORY_PAGE_SIZE);
    if (error || !data) return [];
    return (data as HistoryRow[]).map(historyFromRow);
  }

  private async loadTrips(listId: string): Promise<ShoppingTrip[]> {
    const { data, error } = await this.client
      .from("shopping_trips")
      .select("*")
      .eq("list_id", listId)
      .order("completed_at", { ascending: false })
      .limit(TRIPS_PAGE_SIZE);
    if (error || !data) return [];
    return (data as TripRow[]).map(tripFromRow);
  }
}
