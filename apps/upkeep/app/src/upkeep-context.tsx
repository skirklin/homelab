/**
 * Upkeep-specific state management (no auth - that comes from shared)
 */

import { createContext, useContext, useReducer, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useAuth } from "@kirkl/shared";
import { subscribeToUserSlugs, subscribeToList } from "./subscription";
import type { Task, TaskList, Completion } from "./types";

export interface UpkeepState {
  userSlugs: Record<string, string>; // { "home": "listId123" }
  list: TaskList | null;
  tasks: Map<string, Task>;
  completions: Completion[]; // Recent completions for history view
  loading: boolean;
}

export type UpkeepAction =
  | { type: "SET_USER_SLUGS"; slugs: Record<string, string> }
  | { type: "SET_LIST"; list: TaskList | null }
  | { type: "SET_TASK"; task: Task }
  | { type: "REMOVE_TASK"; taskId: string }
  | { type: "CLEAR_TASKS" }
  | { type: "SET_COMPLETIONS"; completions: Completion[] }
  | { type: "SET_LOADING"; loading: boolean };

function reducer(state: UpkeepState, action: UpkeepAction): UpkeepState {
  switch (action.type) {
    case "SET_USER_SLUGS":
      return { ...state, userSlugs: action.slugs };

    case "SET_LIST":
      return { ...state, list: action.list };

    case "SET_TASK": {
      const newTasks = new Map(state.tasks);
      newTasks.set(action.task.id, action.task);
      return { ...state, tasks: newTasks };
    }

    case "REMOVE_TASK": {
      const newTasks = new Map(state.tasks);
      newTasks.delete(action.taskId);
      return { ...state, tasks: newTasks };
    }

    case "CLEAR_TASKS":
      return { ...state, tasks: new Map() };

    case "SET_COMPLETIONS":
      return { ...state, completions: action.completions };

    case "SET_LOADING":
      return { ...state, loading: action.loading };

    default:
      return state;
  }
}

const initialState: UpkeepState = {
  userSlugs: {},
  list: null,
  tasks: new Map(),
  completions: [],
  loading: true,
};

interface ContextType {
  state: UpkeepState;
  dispatch: React.Dispatch<UpkeepAction>;
  setCurrentList: (listId: string) => void;
}

const UpkeepContext = createContext<ContextType | null>(null);

export function UpkeepProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { user } = useAuth();
  const slugsUnsubRef = useRef<(() => void) | null>(null);
  const listUnsubsRef = useRef<(() => void)[]>([]);
  const currentListIdRef = useRef<string | null>(null);

  // Subscribe to user's slugs when authenticated
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

    const cancelled = () => currentListIdRef.current !== listId;
    subscribeToList(listId, user.uid, dispatch, cancelled).then((unsubs) => {
      if (cancelled()) {
        unsubs.forEach((unsub) => unsub());
        return;
      }
      listUnsubsRef.current = unsubs;
    }).catch((err) => {
      console.error("[upkeep] subscribeToList failed:", err);
      if (!cancelled()) {
        dispatch({ type: "SET_LOADING", loading: false });
      }
    });
  }, [user]);

  return (
    <UpkeepContext.Provider value={{ state, dispatch, setCurrentList }}>
      {children}
    </UpkeepContext.Provider>
  );
}

export function useUpkeepContext() {
  const context = useContext(UpkeepContext);
  if (!context) {
    throw new Error("useUpkeepContext must be used within UpkeepProvider");
  }
  return context;
}
