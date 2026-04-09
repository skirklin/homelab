/**
 * Shopping-specific state management (no auth - that comes from shared)
 */

import { createContext, useContext, useReducer, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useAuth } from "@kirkl/shared";
import { useShoppingBackend, useUserBackend } from "@kirkl/shared";
import type { ShoppingItem, ShoppingList, ItemHistory, ShoppingTrip } from "./types";
import type { ShoppingBackend } from "@homelab/backend";

export type SyncStatus = "synced" | "pending" | "offline";

export interface ShoppingState {
  userSlugs: Record<string, string>;
  list: ShoppingList | null;
  items: Map<string, ShoppingItem>;
  history: ItemHistory[];
  trips: ShoppingTrip[];
  loading: boolean;
  syncStatus: SyncStatus;
}

export type ShoppingAction =
  | { type: "SET_USER_SLUGS"; slugs: Record<string, string> }
  | { type: "SET_LIST"; list: ShoppingList | null }
  | { type: "SET_ITEM"; item: ShoppingItem }
  | { type: "REMOVE_ITEM"; itemId: string }
  | { type: "CLEAR_ITEMS" }
  | { type: "SET_HISTORY"; history: ItemHistory[] }
  | { type: "SET_TRIPS"; trips: ShoppingTrip[] }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_SYNC_STATUS"; status: SyncStatus };

function reducer(state: ShoppingState, action: ShoppingAction): ShoppingState {
  switch (action.type) {
    case "SET_USER_SLUGS":
      return { ...state, userSlugs: action.slugs };
    case "SET_LIST":
      return { ...state, list: action.list };
    case "SET_ITEM": {
      const newItems = new Map(state.items);
      newItems.set(action.item.id, action.item);
      return { ...state, items: newItems };
    }
    case "REMOVE_ITEM": {
      const newItems = new Map(state.items);
      newItems.delete(action.itemId);
      return { ...state, items: newItems };
    }
    case "CLEAR_ITEMS":
      return { ...state, items: new Map() };
    case "SET_HISTORY":
      return { ...state, history: action.history };
    case "SET_TRIPS":
      return { ...state, trips: action.trips };
    case "SET_LOADING":
      return { ...state, loading: action.loading };
    case "SET_SYNC_STATUS":
      return { ...state, syncStatus: action.status };
    default:
      return state;
  }
}

const initialState: ShoppingState = {
  userSlugs: {},
  list: null,
  items: new Map(),
  history: [],
  trips: [],
  loading: true,
  syncStatus: "synced",
};

interface ContextType {
  state: ShoppingState;
  dispatch: React.Dispatch<ShoppingAction>;
  setCurrentList: (listId: string) => void;
}

const ShoppingContext = createContext<ContextType | null>(null);

/** Convert a backend ShoppingItem to the app's local ShoppingItem type. */
function toLocalItem(item: import("@homelab/backend").ShoppingItem): ShoppingItem {
  return {
    id: item.id,
    ingredient: item.ingredient,
    note: item.note || undefined,
    categoryId: item.categoryId,
    checked: item.checked,
    addedBy: item.addedBy || "",
    addedAt: new Date(), // backend type doesn't carry addedAt; use now as placeholder
    checkedBy: item.checkedBy,
    checkedAt: item.checkedAt ? new Date(item.checkedAt) : undefined,
  };
}

/** Convert a backend ShoppingList to the app's local ShoppingList type. */
function toLocalList(list: import("@homelab/backend").ShoppingList): ShoppingList {
  return {
    id: list.id,
    name: list.name,
    owners: list.owners,
    categories: list.categories,
    created: new Date(), // backend type doesn't carry timestamps
    updated: new Date(),
  };
}

function subscribeToListViaBackend(
  shopping: ShoppingBackend,
  listId: string,
  dispatch: React.Dispatch<ShoppingAction>,
): () => void {
  dispatch({ type: "CLEAR_ITEMS" });
  dispatch({ type: "SET_LIST", list: null });
  dispatch({ type: "SET_LOADING", loading: true });

  let firstItems = true;

  return shopping.subscribeToList(listId, {
    onList: (list) => {
      dispatch({ type: "SET_LIST", list: toLocalList(list) });
    },
    onItems: (items) => {
      // The backend delivers full state each time. Reconcile with our Map.
      dispatch({ type: "CLEAR_ITEMS" });
      for (const item of items) {
        dispatch({ type: "SET_ITEM", item: toLocalItem(item) });
      }
      if (firstItems) {
        firstItems = false;
        dispatch({ type: "SET_LOADING", loading: false });
        dispatch({ type: "SET_SYNC_STATUS", status: "synced" });
      }
    },
    onHistory: (entries) => {
      dispatch({
        type: "SET_HISTORY",
        history: entries.map((e) => ({
          ingredient: e.ingredient,
          categoryId: e.categoryId,
          lastAdded: e.lastAdded,
        })),
      });
    },
    onTrips: (trips) => {
      dispatch({
        type: "SET_TRIPS",
        trips: trips.map((t) => ({
          id: t.id,
          completedAt: t.completedAt,
          items: t.items.map((item) => ({
            ingredient: item.ingredient,
            note: item.note || undefined,
            categoryId: item.categoryId,
          })),
        })),
      });
    },
    onDeleted: () => {
      dispatch({ type: "SET_LIST", list: null });
    },
  });
}

export function ShoppingProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { user } = useAuth();
  const shopping = useShoppingBackend();
  const userBackend = useUserBackend();
  const slugsUnsubRef = useRef<(() => void) | null>(null);
  const listUnsubRef = useRef<(() => void) | null>(null);
  const currentListIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (user) {
      slugsUnsubRef.current = userBackend.subscribeSlugs(user.uid, "shopping", (slugs) => {
        dispatch({ type: "SET_USER_SLUGS", slugs });
      });
    }
    return () => {
      if (slugsUnsubRef.current) {
        slugsUnsubRef.current();
        slugsUnsubRef.current = null;
      }
      if (listUnsubRef.current) {
        listUnsubRef.current();
        listUnsubRef.current = null;
      }
    };
  }, [user, userBackend]);

  const setCurrentList = useCallback((listId: string) => {
    if (!user) return;
    if (currentListIdRef.current === listId) return;

    if (listUnsubRef.current) {
      listUnsubRef.current();
      listUnsubRef.current = null;
    }
    currentListIdRef.current = listId;

    const unsub = subscribeToListViaBackend(shopping, listId, dispatch);

    // Check if we navigated away before subscription resolved
    if (currentListIdRef.current !== listId) {
      unsub();
      return;
    }
    listUnsubRef.current = unsub;
  }, [user, shopping]);

  return (
    <ShoppingContext.Provider value={{ state, dispatch, setCurrentList }}>
      {children}
    </ShoppingContext.Provider>
  );
}

export function useShoppingContext() {
  const context = useContext(ShoppingContext);
  if (!context) {
    throw new Error("useShoppingContext must be used within ShoppingProvider");
  }
  return context;
}
