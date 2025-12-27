import { onSnapshot, type Unsubscribe } from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./backend";
import { getListRef, getItemsRef, ensureListExists } from "./firestore";
import type { GroceryItemStore, GroceryListStore } from "./types";
import { itemFromStore, listFromStore } from "./types";
import type { AppState, Action } from "./context";

type Dispatch = React.Dispatch<Action>;

export function subscribeToAuth(dispatch: Dispatch): Unsubscribe {
  return onAuthStateChanged(auth, (user) => {
    dispatch({ type: "SET_AUTH_USER", user });
    if (!user) {
      dispatch({ type: "SET_LIST", list: null });
      dispatch({ type: "CLEAR_ITEMS" });
      dispatch({ type: "SET_LOADING", loading: false });
    }
  });
}

export async function subscribeToData(
  userId: string,
  dispatch: Dispatch
): Promise<Unsubscribe[]> {
  // Ensure list exists and user is an owner
  await ensureListExists(userId);

  const unsubscribers: Unsubscribe[] = [];

  // Subscribe to list
  const listUnsub = onSnapshot(
    getListRef(),
    (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as GroceryListStore;
        dispatch({ type: "SET_LIST", list: listFromStore(snapshot.id, data) });
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
