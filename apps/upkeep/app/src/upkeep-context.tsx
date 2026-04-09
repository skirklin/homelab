/**
 * Upkeep-specific state management (no auth - that comes from shared)
 */

import { createContext, useContext, useReducer, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useAuth } from "@kirkl/shared";
import { useUpkeepBackend, useUserBackend } from "./backend-provider";
import { setCurrentListId } from "./current-list-id";
import { taskFromBackend, listFromBackend, completionFromBackend } from "./adapters";
import type { Task, TaskList, Completion } from "./types";
import type { UpkeepBackend } from "@homelab/backend";

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
  | { type: "SET_TASKS"; tasks: Task[] }
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

    case "SET_TASKS": {
      const newTasks = new Map<string, Task>();
      for (const task of action.tasks) {
        newTasks.set(task.id, task);
      }
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

function subscribeToListViaBackend(
  upkeep: UpkeepBackend,
  listId: string,
  dispatch: React.Dispatch<UpkeepAction>,
): () => void {
  // Keep pocketbase.ts currentListId in sync for any remaining direct callers
  setCurrentListId(listId);

  dispatch({ type: "CLEAR_TASKS" });
  dispatch({ type: "SET_LIST", list: null });
  dispatch({ type: "SET_LOADING", loading: true });

  let firstTasks = true;

  return upkeep.subscribeToList(listId, "", {
    onList: (list) => {
      dispatch({ type: "SET_LIST", list: listFromBackend(list) });
    },
    onTasks: (tasks) => {
      dispatch({ type: "SET_TASKS", tasks: tasks.map(taskFromBackend) });
      if (firstTasks) {
        firstTasks = false;
        dispatch({ type: "SET_LOADING", loading: false });
      }
    },
    onCompletions: (completions) => {
      dispatch({ type: "SET_COMPLETIONS", completions: completions.map(completionFromBackend) });
    },
    onDeleted: () => {
      dispatch({ type: "SET_LIST", list: null });
    },
  });
}

export function UpkeepProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { user } = useAuth();
  const upkeep = useUpkeepBackend();
  const userBackend = useUserBackend();
  const slugsUnsubRef = useRef<(() => void) | null>(null);
  const listUnsubRef = useRef<(() => void) | null>(null);
  const currentListIdRef = useRef<string | null>(null);

  // Subscribe to user's slugs when authenticated
  useEffect(() => {
    if (user) {
      slugsUnsubRef.current = userBackend.subscribeSlugs(user.uid, "household", (slugs) => {
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

  // Function to subscribe to a specific list (called by components)
  const setCurrentList = useCallback((listId: string) => {
    if (!user) return;

    // Already subscribed to this list
    if (currentListIdRef.current === listId) return;

    // Cleanup previous list subscription
    if (listUnsubRef.current) {
      listUnsubRef.current();
      listUnsubRef.current = null;
    }
    currentListIdRef.current = listId;

    const unsub = subscribeToListViaBackend(upkeep, listId, dispatch);

    // Check if we navigated away before subscription resolved
    if (currentListIdRef.current !== listId) {
      unsub();
      return;
    }
    listUnsubRef.current = unsub;
  }, [user, upkeep]);

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
