import { createContext, useContext, useReducer, type ReactNode } from "react";
import type { User } from "firebase/auth";
import type { GroceryItem, GroceryList, ItemHistory, ShoppingTrip } from "./types";

export interface AppState {
  authUser: User | null | undefined; // undefined = still loading
  userSlugs: Record<string, string>; // { "groceries": "listId123" }
  list: GroceryList | null;
  items: Map<string, GroceryItem>;
  history: ItemHistory[];
  trips: ShoppingTrip[];
  loading: boolean;
}

export type Action =
  | { type: "SET_AUTH_USER"; user: User | null }
  | { type: "SET_USER_SLUGS"; slugs: Record<string, string> }
  | { type: "SET_LIST"; list: GroceryList | null }
  | { type: "SET_ITEM"; item: GroceryItem }
  | { type: "REMOVE_ITEM"; itemId: string }
  | { type: "CLEAR_ITEMS" }
  | { type: "SET_HISTORY"; history: ItemHistory[] }
  | { type: "SET_TRIPS"; trips: ShoppingTrip[] }
  | { type: "SET_LOADING"; loading: boolean };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_AUTH_USER":
      return { ...state, authUser: action.user };

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

const initialState: AppState = {
  authUser: undefined,
  userSlugs: {},
  list: null,
  items: new Map(),
  history: [],
  trips: [],
  loading: true,
};

interface ContextType {
  state: AppState;
  dispatch: React.Dispatch<Action>;
}

const Context = createContext<ContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  return (
    <Context.Provider value={{ state, dispatch }}>{children}</Context.Provider>
  );
}

export function useAppContext() {
  const context = useContext(Context);
  if (!context) {
    throw new Error("useAppContext must be used within AppProvider");
  }
  return context;
}
