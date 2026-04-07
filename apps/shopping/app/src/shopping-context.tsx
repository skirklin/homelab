/**
 * Shopping-specific state management (no auth - that comes from shared)
 */

import { createContext, useContext, useReducer, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useAuth } from "@kirkl/shared";
import { subscribeToUserSlugs, subscribeToList } from "./subscription";
import type { ShoppingItem, ShoppingList, ItemHistory, ShoppingTrip } from "./types";

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

export function ShoppingProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { user } = useAuth();
  const slugsUnsubRef = useRef<(() => void) | null>(null);
  const listUnsubsRef = useRef<(() => void)[]>([]);
  const currentListIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (user) {
      slugsUnsubRef.current = subscribeToUserSlugs(user.uid, dispatch, () => cancelled);
    }
    return () => {
      cancelled = true;
      if (slugsUnsubRef.current) {
        slugsUnsubRef.current();
        slugsUnsubRef.current = null;
      }
      listUnsubsRef.current.forEach((unsub) => unsub());
      listUnsubsRef.current = [];
    };
  }, [user]);

  const setCurrentList = useCallback((listId: string) => {
    if (!user) return;
    if (currentListIdRef.current === listId) return;

    listUnsubsRef.current.forEach((unsub) => unsub());
    listUnsubsRef.current = [];
    currentListIdRef.current = listId;

    const cancelled = () => currentListIdRef.current !== listId;
    subscribeToList(listId, dispatch, cancelled).then((unsubs) => {
      if (cancelled()) {
        unsubs.forEach((unsub) => unsub());
        return;
      }
      listUnsubsRef.current = unsubs;
    }).catch((err) => {
      console.error("[shopping] subscribeToList failed:", err);
      if (!cancelled()) {
        dispatch({ type: "SET_LOADING", loading: false });
      }
    });
  }, [user]);

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
