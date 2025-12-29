import { onSnapshot, query, orderBy, limit, type Unsubscribe } from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./backend";
import { getListRef, getItemsRef, getHistoryRef, getTripsRef, ensureListExists, setCurrentListId, getUserProfile, addListToUserProfile } from "./firestore";
import type { GroceryItemStore, GroceryListStore, ItemHistoryStore, ShoppingTripStore } from "./types";
import { itemFromStore, listFromStore } from "./types";
import type { AppState, Action } from "./context";

type Dispatch = React.Dispatch<Action>;

export function subscribeToAuth(dispatch: Dispatch): Unsubscribe {
  return onAuthStateChanged(auth, (user) => {
    dispatch({ type: "SET_AUTH_USER", user });
    if (!user) {
      dispatch({ type: "SET_LIST", list: null });
      dispatch({ type: "CLEAR_ITEMS" });
      dispatch({ type: "SET_USER_LISTS", lists: [] });
      dispatch({ type: "SET_LOADING", loading: false });
    }
  });
}

export async function loadUserLists(userId: string, dispatch: Dispatch) {
  const lists = await getUserProfile(userId);
  dispatch({ type: "SET_USER_LISTS", lists });
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
    async (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as GroceryListStore;
        const list = listFromStore(snapshot.id, data);
        dispatch({ type: "SET_LIST", list });
        // Add to user's profile if not already there
        await addListToUserProfile(userId, snapshot.id, list.name);
      } else {
        dispatch({ type: "SET_LIST", list: null });
      }
    },
    (error) => {
      console.error("List subscription error:", error);
    }
  );
  unsubscribers.push(listUnsub);

  // Subscribe to items
  const itemsUnsub = onSnapshot(
    getItemsRef(),
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
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
        const data = doc.data() as ItemHistoryStore;
        return {
          name: data.name,
          category: data.category,
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
          items: data.items,
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

export function getItemsFromState(state: AppState) {
  return Array.from(state.items.values());
}

export function getItemsByCategory(state: AppState) {
  const items = getItemsFromState(state);
  const grouped = new Map<string, typeof items>();

  for (const item of items) {
    const existing = grouped.get(item.category) || [];
    existing.push(item);
    grouped.set(item.category, existing);
  }

  return grouped;
}
