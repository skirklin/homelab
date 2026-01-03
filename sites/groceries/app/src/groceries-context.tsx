/**
 * Groceries-specific state management (no auth - that comes from shared)
 */

import { createContext, useContext, useReducer, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useAuth } from "@kirkl/shared";
import { subscribeToUserSlugs, subscribeToList } from "./subscription";
import type { GroceryItem, GroceryList, ItemHistory, ShoppingTrip } from "./types";

export type SyncStatus = "synced" | "pending" | "offline";

export interface GroceriesState {
  userSlugs: Record<string, string>; // { "groceries": "listId123" }
  list: GroceryList | null;
  items: Map<string, GroceryItem>;
  history: ItemHistory[];
  trips: ShoppingTrip[];
  loading: boolean;
  syncStatus: SyncStatus;
}

export type GroceriesAction =
  | { type: "SET_USER_SLUGS"; slugs: Record<string, string> }
  | { type: "SET_LIST"; list: GroceryList | null }
  | { type: "SET_ITEM"; item: GroceryItem }
  | { type: "REMOVE_ITEM"; itemId: string }
  | { type: "CLEAR_ITEMS" }
  | { type: "SET_HISTORY"; history: ItemHistory[] }
  | { type: "SET_TRIPS"; trips: ShoppingTrip[] }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_SYNC_STATUS"; status: SyncStatus };

function reducer(state: GroceriesState, action: GroceriesAction): GroceriesState {
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

const initialState: GroceriesState = {
  userSlugs: {},
  list: null,
  items: new Map(),
  history: [],
  trips: [],
  loading: true,
  syncStatus: "synced",
};

interface ContextType {
  state: GroceriesState;
  dispatch: React.Dispatch<GroceriesAction>;
  setCurrentList: (listId: string) => void;
}

const GroceriesContext = createContext<ContextType | null>(null);

export function GroceriesProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { user } = useAuth();
  const slugsUnsubRef = useRef<(() => void) | null>(null);
  const listUnsubsRef = useRef<(() => void)[]>([]);
  const currentListIdRef = useRef<string | null>(null);

  // Subscribe to user's slugs when authenticated
  useEffect(() => {
    if (user) {
      slugsUnsubRef.current = subscribeToUserSlugs(user.uid, dispatch);
    }
    return () => {
      if (slugsUnsubRef.current) {
        slugsUnsubRef.current();
        slugsUnsubRef.current = null;
      }
      // Also cleanup list subscriptions
      listUnsubsRef.current.forEach((unsub) => unsub());
      listUnsubsRef.current = [];
    };
  }, [user]);

  // Function to subscribe to a specific list (called by components)
  const setCurrentList = useCallback((listId: string) => {
    if (!user) return;

    // Already subscribed to this list
    if (currentListIdRef.current === listId) return;

    // Cleanup previous list subscriptions
    listUnsubsRef.current.forEach((unsub) => unsub());
    listUnsubsRef.current = [];
    currentListIdRef.current = listId;

    subscribeToList(listId, user.uid, dispatch).then((unsubs) => {
      listUnsubsRef.current = unsubs;
    });
  }, [user]);

  return (
    <GroceriesContext.Provider value={{ state, dispatch, setCurrentList }}>
      {children}
    </GroceriesContext.Provider>
  );
}

export function useGroceriesContext() {
  const context = useContext(GroceriesContext);
  if (!context) {
    throw new Error("useGroceriesContext must be used within GroceriesProvider");
  }
  return context;
}
