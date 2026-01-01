import { createContext, useContext, useReducer, type ReactNode, type Dispatch } from "react";
import type { LogEntry, LifeLog } from "./types";

export interface LifeState {
  log: LifeLog | null;
  entries: Map<string, LogEntry>;
  loading: boolean;
}

export type LifeAction =
  | { type: "SET_LOG"; log: LifeLog | null }
  | { type: "SET_ENTRY"; entry: LogEntry }
  | { type: "SET_ENTRIES"; entries: LogEntry[] }
  | { type: "REMOVE_ENTRY"; entryId: string }
  | { type: "CLEAR_ENTRIES" }
  | { type: "SET_LOADING"; loading: boolean };

const initialState: LifeState = {
  log: null,
  entries: new Map(),
  loading: true,
};

function reducer(state: LifeState, action: LifeAction): LifeState {
  switch (action.type) {
    case "SET_LOG":
      return { ...state, log: action.log };
    case "SET_ENTRY": {
      const entries = new Map(state.entries);
      entries.set(action.entry.id, action.entry);
      return { ...state, entries };
    }
    case "SET_ENTRIES": {
      const entries = new Map<string, LogEntry>();
      action.entries.forEach(e => entries.set(e.id, e));
      return { ...state, entries };
    }
    case "REMOVE_ENTRY": {
      const entries = new Map(state.entries);
      entries.delete(action.entryId);
      return { ...state, entries };
    }
    case "CLEAR_ENTRIES":
      return { ...state, entries: new Map() };
    case "SET_LOADING":
      return { ...state, loading: action.loading };
    default:
      return state;
  }
}

interface LifeContextType {
  state: LifeState;
  dispatch: Dispatch<LifeAction>;
}

const LifeContext = createContext<LifeContextType>({
  state: initialState,
  dispatch: () => {},
});

export function LifeProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <LifeContext.Provider value={{ state, dispatch }}>
      {children}
    </LifeContext.Provider>
  );
}

export function useLife() {
  return useContext(LifeContext);
}

export function useLifeContext() {
  return useContext(LifeContext);
}
