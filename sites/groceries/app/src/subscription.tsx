import { onSnapshot, query, orderBy, limit, type Unsubscribe } from "firebase/firestore";
import { getListRef, getItemsRef, getHistoryRef, getTripsRef, ensureListExists, setCurrentListId, getUserSlugs, getUserRef } from "./firestore";
import type { GroceryItemStore, GroceryListStore, ItemHistoryStore, LegacyItemHistoryStore, ShoppingTripStore, UserProfileStore } from "./types";
import { itemFromStore, listFromStore } from "./types";
import type { GroceriesState, GroceriesAction } from "./groceries-context";

type Dispatch = React.Dispatch<GroceriesAction>;

export async function loadUserSlugs(userId: string, dispatch: Dispatch) {
  const slugs = await getUserSlugs(userId);
  dispatch({ type: "SET_USER_SLUGS", slugs });
}

export function subscribeToUserSlugs(userId: string, dispatch: Dispatch): Unsubscribe {
  return onSnapshot(
    getUserRef(userId),
    (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as UserProfileStore;
        dispatch({ type: "SET_USER_SLUGS", slugs: data.slugs || {} });
      } else {
        dispatch({ type: "SET_USER_SLUGS", slugs: {} });
      }
    },
    (error) => {
      console.error("User slugs subscription error:", error);
    }
  );
}

export async function subscribeToList(
  listId: string,
  userId: string,
  dispatch: Dispatch
): Promise<Unsubscribe[]> {
  // Set the current list ID for firestore operations
  setCurrentListId(listId);

  // Clear previous list data
  dispatch({ type: "CLEAR_ITEMS" });
  dispatch({ type: "SET_LIST", list: null });
  dispatch({ type: "SET_LOADING", loading: true });

  await ensureListExists(userId);

  const unsubscribers: Unsubscribe[] = [];

  // Subscribe to list
  const listUnsub = onSnapshot(
    getListRef(),
    (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as GroceryListStore;
        const list = listFromStore(snapshot.id, data);
        dispatch({ type: "SET_LIST", list });
      } else {
        dispatch({ type: "SET_LIST", list: null });
      }
    },
    (error) => {
      console.error("List subscription error:", error);
    }
  );
  unsubscribers.push(listUnsub);

  // Subscribe to items (with metadata to track sync status)
  const itemsUnsub = onSnapshot(
    getItemsRef(),
    { includeMetadataChanges: true },
    (snapshot) => {
      // Update sync status based on metadata
      const { fromCache, hasPendingWrites } = snapshot.metadata;
      if (hasPendingWrites) {
        dispatch({ type: "SET_SYNC_STATUS", status: "pending" });
      } else if (fromCache) {
        dispatch({ type: "SET_SYNC_STATUS", status: "offline" });
      } else {
        dispatch({ type: "SET_SYNC_STATUS", status: "synced" });
      }

      snapshot.docChanges().forEach((change) => {
        // Skip metadata-only changes (no actual doc changes)
        if (change.type === "added" || change.type === "modified") {
          const data = change.doc.data() as GroceryItemStore;
          dispatch({
            type: "SET_ITEM",
            item: itemFromStore(change.doc.id, data),
          });
        } else if (change.type === "removed") {
          dispatch({ type: "REMOVE_ITEM", itemId: change.doc.id });
        }
      });
      dispatch({ type: "SET_LOADING", loading: false });
    },
    (error) => {
      console.error("Items subscription error:", error);
      dispatch({ type: "SET_LOADING", loading: false });
    }
  );
  unsubscribers.push(itemsUnsub);

  // Subscribe to history for autocomplete
  const historyUnsub = onSnapshot(
    getHistoryRef(),
    (snapshot) => {
      const history = snapshot.docs.map((doc) => {
        const data = doc.data() as ItemHistoryStore & LegacyItemHistoryStore;
        return {
          // Handle legacy history entries that use 'name' instead of 'ingredient'
          ingredient: data.ingredient || data.name || "",
          categoryId: data.categoryId || "uncategorized",
          lastAdded: data.lastAdded.toDate(),
        };
      });
      // Sort by most recently added first
      history.sort((a, b) => b.lastAdded.getTime() - a.lastAdded.getTime());
      dispatch({ type: "SET_HISTORY", history });
    },
    (error) => {
      console.error("History subscription error:", error);
    }
  );
  unsubscribers.push(historyUnsub);

  // Subscribe to shopping trips (most recent 50)
  const tripsQuery = query(getTripsRef(), orderBy("completedAt", "desc"), limit(50));
  const tripsUnsub = onSnapshot(
    tripsQuery,
    (snapshot) => {
      const trips = snapshot.docs.map((doc) => {
        const data = doc.data() as ShoppingTripStore;
        return {
          id: doc.id,
          completedAt: data.completedAt.toDate(),
          // Handle legacy trip items that use 'name' instead of 'ingredient'
          items: data.items.map((item) => {
            const legacyItem = item as { name?: string; ingredient?: string; note?: string; categoryId: string };
            return {
              ingredient: legacyItem.ingredient || legacyItem.name || "",
              note: legacyItem.note,
              categoryId: legacyItem.categoryId || "uncategorized",
            };
          }),
        };
      });
      dispatch({ type: "SET_TRIPS", trips });
    },
    (error) => {
      console.error("Trips subscription error:", error);
    }
  );
  unsubscribers.push(tripsUnsub);

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
