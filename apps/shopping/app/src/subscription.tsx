/**
 * PocketBase real-time subscriptions for the shopping app.
 * Replaces Firestore onSnapshot listeners with PocketBase SSE subscriptions.
 */
import { getBackend } from "@kirkl/shared";
import { setCurrentListId, getUserSlugs } from "./pocketbase";
import { itemFromRecord, listFromRecord } from "./types";
import type { GroceriesState, GroceriesAction } from "./groceries-context";

type Dispatch = React.Dispatch<GroceriesAction>;

function pb() {
  return getBackend();
}

export async function loadUserSlugs(userId: string, dispatch: Dispatch) {
  const slugs = await getUserSlugs(userId);
  dispatch({ type: "SET_USER_SLUGS", slugs });
}

export function subscribeToUserSlugs(userId: string, dispatch: Dispatch): () => void {
  // Subscribe to user record changes
  pb().collection("users").subscribe(userId, (e) => {
    dispatch({
      type: "SET_USER_SLUGS",
      slugs: e.record.shopping_slugs || {},
    });
  });

  return () => {
    pb().collection("users").unsubscribe(userId);
  };
}

export async function subscribeToList(
  listId: string,
  dispatch: Dispatch
): Promise<Array<() => void>> {
  setCurrentListId(listId);

  dispatch({ type: "CLEAR_ITEMS" });
  dispatch({ type: "SET_LIST", list: null });
  dispatch({ type: "SET_LOADING", loading: true });

  const unsubscribers: Array<() => void> = [];

  // Load initial list data
  try {
    const list = await pb().collection("shopping_lists").getOne(listId);
    dispatch({ type: "SET_LIST", list: listFromRecord(list) });
  } catch {
    dispatch({ type: "SET_LIST", list: null });
  }

  // Subscribe to list changes
  pb().collection("shopping_lists").subscribe(listId, (e) => {
    if (e.action === "delete") {
      dispatch({ type: "SET_LIST", list: null });
    } else {
      dispatch({ type: "SET_LIST", list: listFromRecord(e.record) });
    }
  });
  unsubscribers.push(() => pb().collection("shopping_lists").unsubscribe(listId));

  // Load initial items
  try {
    const items = await pb().collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });
    for (const item of items) {
      dispatch({ type: "SET_ITEM", item: itemFromRecord(item) });
    }
  } catch (e) {
    console.error("Failed to load items:", e);
  }
  dispatch({ type: "SET_LOADING", loading: false });
  dispatch({ type: "SET_SYNC_STATUS", status: "synced" });

  // Subscribe to item changes
  pb().collection("shopping_items").subscribe("*", (e) => {
    if (e.record.list !== listId) return;
    if (e.action === "delete") {
      dispatch({ type: "REMOVE_ITEM", itemId: e.record.id });
    } else {
      dispatch({ type: "SET_ITEM", item: itemFromRecord(e.record) });
    }
  });
  unsubscribers.push(() => pb().collection("shopping_items").unsubscribe("*"));

  // Load history
  try {
    const history = await pb().collection("shopping_history").getFullList({
      filter: `list = "${listId}"`,
      sort: "-last_added",
    });
    dispatch({
      type: "SET_HISTORY",
      history: history.map((h) => ({
        ingredient: h.ingredient || "",
        categoryId: h.category_id || "uncategorized",
        lastAdded: new Date(h.last_added),
      })),
    });
  } catch (e) {
    console.error("Failed to load history:", e);
  }

  // Subscribe to history changes
  pb().collection("shopping_history").subscribe("*", (e) => {
    if (e.record.list !== listId) return;
    // Reload all history on any change (simpler than incremental updates)
    pb().collection("shopping_history").getFullList({
      filter: `list = "${listId}"`,
      sort: "-last_added",
    }).then((history) => {
      dispatch({
        type: "SET_HISTORY",
        history: history.map((h) => ({
          ingredient: h.ingredient || "",
          categoryId: h.category_id || "uncategorized",
          lastAdded: new Date(h.last_added),
        })),
      });
    });
  });
  unsubscribers.push(() => pb().collection("shopping_history").unsubscribe("*"));

  // Load trips
  try {
    const trips = await pb().collection("shopping_trips").getList(1, 50, {
      filter: `list = "${listId}"`,
      sort: "-completed_at",
    });
    dispatch({
      type: "SET_TRIPS",
      trips: trips.items.map((t) => ({
        id: t.id,
        completedAt: new Date(t.completed_at),
        items: (t.items || []).map((item: Record<string, string>) => ({
          ingredient: item.ingredient || item.name || "",
          note: item.note,
          categoryId: item.categoryId || "uncategorized",
        })),
      })),
    });
  } catch (e) {
    console.error("Failed to load trips:", e);
  }

  return unsubscribers;
}

export function getItemsFromState(state: GroceriesState) {
  return Array.from(state.items.values());
}

export function getItemsByCategoryId(state: GroceriesState) {
  const items = getItemsFromState(state);
  const grouped = new Map<string, typeof items>();
  for (const item of items) {
    const existing = grouped.get(item.categoryId) || [];
    existing.push(item);
    grouped.set(item.categoryId, existing);
  }
  return grouped;
}
