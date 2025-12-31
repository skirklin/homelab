/**
 * Groceries-specific state management (no auth - that comes from shared)
 */

import { createContext, useContext, useReducer, type ReactNode } from "react";
import type { GroceryItem, GroceryList, ItemHistory, ShoppingTrip } from "./types";

export interface GroceriesState {
  userSlugs: Record<string, string>; // { "groceries": "listId123" }
  list: GroceryList | null;
  items: Map<string, GroceryItem>;
  history: ItemHistory[];
  trips: ShoppingTrip[];
  loading: boolean;
}

export type GroceriesAction =
  | { type: "SET_USER_SLUGS"; slugs: Record<string, string> }
  | { type: "SET_LIST"; list: GroceryList | null }
  | { type: "SET_ITEM"; item: GroceryItem }
  | { type: "REMOVE_ITEM"; itemId: string }
  | { type: "CLEAR_ITEMS" }
  | { type: "SET_HISTORY"; history: ItemHistory[] }
  | { type: "SET_TRIPS"; trips: ShoppingTrip[] }
  | { type: "SET_LOADING"; loading: boolean };

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
};

interface ContextType {
  state: GroceriesState;
  dispatch: React.Dispatch<GroceriesAction>;
}

const GroceriesContext = createContext<ContextType | null>(null);

export function GroceriesProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  return (
    <GroceriesContext.Provider value={{ state, dispatch }}>
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
