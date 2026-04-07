import { createContext, useContext, useReducer, type ReactNode } from "react";
import type { Task, TaskList, Completion } from "./types";

export interface AppState {
  authUser: { id: string; uid: string; email: string; name: string } | null | undefined; // undefined = still loading
  userSlugs: Record<string, string>; // { "home": "listId123" }
  list: TaskList | null;
  tasks: Map<string, Task>;
  completions: Completion[]; // Recent completions for history view
  loading: boolean;
}

export type Action =
  | { type: "SET_AUTH_USER"; user: { id: string; uid: string; email: string; name: string } | null }
  | { type: "SET_USER_SLUGS"; slugs: Record<string, string> }
  | { type: "SET_LIST"; list: TaskList | null }
  | { type: "SET_TASK"; task: Task }
  | { type: "REMOVE_TASK"; taskId: string }
  | { type: "CLEAR_TASKS" }
  | { type: "SET_COMPLETIONS"; completions: Completion[] }
  | { type: "SET_LOADING"; loading: boolean };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_AUTH_USER":
      return { ...state, authUser: action.user };

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

const initialState: AppState = {
  authUser: undefined,
  userSlugs: {},
  list: null,
  tasks: new Map(),
  completions: [],
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
