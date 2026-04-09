/**
 * PocketBase real-time subscriptions for the shopping app.
 */
import { subscribeToRecord, subscribeToCollection, subscribeToCollectionReload } from "@kirkl/shared";
import { setCurrentListId } from "./pocketbase";
import { itemFromRecord, listFromRecord } from "./types";
import type { ShoppingState, ShoppingAction } from "./shopping-context";

type Dispatch = React.Dispatch<ShoppingAction>;

export function subscribeToUserSlugs(userId: string, dispatch: Dispatch, cancelled: () => boolean): () => void {
  return subscribeToRecord("users", userId, cancelled, {
    onData: (record) => {
      dispatch({ type: "SET_USER_SLUGS", slugs: record.shopping_slugs || {} });
    },
  });
}

export async function subscribeToList(
  listId: string,
  dispatch: Dispatch,
  cancelled: () => boolean
): Promise<Array<() => void>> {
  setCurrentListId(listId);

  dispatch({ type: "CLEAR_ITEMS" });
  dispatch({ type: "SET_LIST", list: null });
  dispatch({ type: "SET_LOADING", loading: true });

  const unsubs: Array<() => void> = [];

  // List metadata
  unsubs.push(subscribeToRecord("shopping_lists", listId, cancelled, {
    onData: (r) => dispatch({ type: "SET_LIST", list: listFromRecord(r) }),
    onDelete: () => dispatch({ type: "SET_LIST", list: null }),
  }));

  // Items
  unsubs.push(subscribeToCollection("shopping_items", cancelled, {
    filter: `list = "${listId}"`,
    belongsTo: (r) => r.list === listId,
    onInitial: (records) => {
      for (const r of records) {
        dispatch({ type: "SET_ITEM", item: itemFromRecord(r) });
      }
      if (!cancelled()) {
        dispatch({ type: "SET_LOADING", loading: false });
        dispatch({ type: "SET_SYNC_STATUS", status: "synced" });
      }
    },
    onChange: (action, r) => {
      if (action === "delete") {
        dispatch({ type: "REMOVE_ITEM", itemId: r.id });
      } else {
        dispatch({ type: "SET_ITEM", item: itemFromRecord(r) });
      }
    },
    onError: (err) => console.error("Failed to load items:", err),
  }));

  // History — reload entirely on any change
  unsubs.push(subscribeToCollectionReload("shopping_history", cancelled, {
    filter: `list = "${listId}"`,
    sort: "-last_added",
    page: 1,
    perPage: 500,
    belongsTo: (r) => r.list === listId,
    onInitial: (records) => {
      dispatch({
        type: "SET_HISTORY",
        history: records.map((h) => ({
          ingredient: h.ingredient || "",
          categoryId: h.category_id || "uncategorized",
          lastAdded: new Date(h.last_added),
        })),
      });
    },
    onAnyChange: (records) => {
      dispatch({
        type: "SET_HISTORY",
        history: records.map((h) => ({
          ingredient: h.ingredient || "",
          categoryId: h.category_id || "uncategorized",
          lastAdded: new Date(h.last_added),
        })),
      });
    },
    onError: (err) => console.error("Failed to load history:", err),
  }));

  // Trips — paginated reload
  unsubs.push(subscribeToCollectionReload("shopping_trips", cancelled, {
    filter: `list = "${listId}"`,
    sort: "-completed_at",
    page: 1,
    perPage: 50,
    belongsTo: (r) => r.list === listId,
    onInitial: (records) => {
      dispatch({
        type: "SET_TRIPS",
        trips: records.map((t) => ({
          id: t.id,
          completedAt: new Date(t.completed_at),
          items: (t.items || []).map((item: Record<string, string>) => ({
            ingredient: item.ingredient || item.name || "",
            note: item.note,
            categoryId: item.categoryId || "uncategorized",
          })),
        })),
      });
    },
    onAnyChange: (records) => {
      dispatch({
        type: "SET_TRIPS",
        trips: records.map((t) => ({
          id: t.id,
          completedAt: new Date(t.completed_at),
          items: (t.items || []).map((item: Record<string, string>) => ({
            ingredient: item.ingredient || item.name || "",
            note: item.note,
            categoryId: item.categoryId || "uncategorized",
          })),
        })),
      });
    },
    onError: (err) => console.error("Failed to load trips:", err),
  }));

  return unsubs;
}

export function getItemsFromState(state: ShoppingState) {
  return Array.from(state.items.values());
}

export function getItemsByCategoryId(state: ShoppingState) {
  const items = getItemsFromState(state);
  const grouped = new Map<string, typeof items>();
  for (const item of items) {
    const existing = grouped.get(item.categoryId) || [];
    existing.push(item);
    grouped.set(item.categoryId, existing);
  }
  return grouped;
}
