import { onSnapshot, query, orderBy, limit, type Unsubscribe } from "firebase/firestore";
import { getListRef, getTasksRef, getEventsRef, ensureListExists, setCurrentListId, getUserRef } from "./firestore";
import { eventFromStore, type EventStore } from "@kirkl/shared";
import type { TaskStore, TaskListStore, UserProfileStore, Completion } from "./types";
import { taskFromStore, listFromStore, getUrgencyLevel, isTaskSnoozed } from "./types";
import type { UpkeepState, UpkeepAction } from "./upkeep-context";

type Dispatch = React.Dispatch<UpkeepAction>;

export function subscribeToUserSlugs(userId: string, dispatch: Dispatch): Unsubscribe {
  return onSnapshot(
    getUserRef(userId),
    (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as UserProfileStore;
        dispatch({ type: "SET_USER_SLUGS", slugs: data.householdSlugs || {} });
      } else {
        dispatch({ type: "SET_USER_SLUGS", slugs: {} });
      }
    },
    (error) => {
      console.error("User slugs subscription error:", error);
    }
  );
}

export async function subscribeToList(
  listId: string,
  userId: string,
  dispatch: Dispatch
): Promise<Unsubscribe[]> {
  // Set the current list ID for firestore operations
  setCurrentListId(listId);

  // Clear previous list data
  dispatch({ type: "CLEAR_TASKS" });
  dispatch({ type: "SET_LIST", list: null });
  dispatch({ type: "SET_LOADING", loading: true });

  await ensureListExists(userId);

  const unsubscribers: Unsubscribe[] = [];

  // Subscribe to list
  const listUnsub = onSnapshot(
    getListRef(),
    (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as TaskListStore;
        const list = listFromStore(snapshot.id, data);
        dispatch({ type: "SET_LIST", list });
      } else {
        dispatch({ type: "SET_LIST", list: null });
      }
    },
    (error) => {
      console.error("List subscription error:", error);
    }
  );
  unsubscribers.push(listUnsub);

  // Subscribe to tasks
  const tasksUnsub = onSnapshot(
    getTasksRef(),
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added" || change.type === "modified") {
          const data = change.doc.data() as TaskStore;
          dispatch({
            type: "SET_TASK",
            task: taskFromStore(change.doc.id, data),
          });
        } else if (change.type === "removed") {
          dispatch({ type: "REMOVE_TASK", taskId: change.doc.id });
        }
      });
      dispatch({ type: "SET_LOADING", loading: false });
    },
    (error) => {
      console.error("Tasks subscription error:", error);
      dispatch({ type: "SET_LOADING", loading: false });
    }
  );
  unsubscribers.push(tasksUnsub);

  // Subscribe to recent completions (most recent 100)
  const eventsQuery = query(getEventsRef(), orderBy("timestamp", "desc"), limit(100));
  const eventsUnsub = onSnapshot(
    eventsQuery,
    (snapshot) => {
      const completions: Completion[] = snapshot.docs.map((doc) => {
        const data = doc.data() as EventStore;
        return eventFromStore(doc.id, data);
      });
      dispatch({ type: "SET_COMPLETIONS", completions });
    },
    (error) => {
      console.error("Completions subscription error:", error);
    }
  );
  unsubscribers.push(eventsUnsub);

  return unsubscribers;
}

export function getTasksFromState(state: UpkeepState) {
  return Array.from(state.tasks.values());
}

export function getTasksByUrgency(state: UpkeepState) {
  const tasks = getTasksFromState(state);
  const grouped = {
    today: [] as typeof tasks,
    thisWeek: [] as typeof tasks,
    later: [] as typeof tasks,
    snoozed: [] as typeof tasks,
  };

  for (const task of tasks) {
    // Check if task is snoozed first
    if (isTaskSnoozed(task)) {
      grouped.snoozed.push(task);
      continue;
    }
    const urgency = getUrgencyLevel(task);
    grouped[urgency].push(task);
  }

  // Sort each group by due date
  const sortByDue = (a: typeof tasks[0], b: typeof tasks[0]) => {
    const aDate = a.lastCompleted?.getTime() ?? 0;
    const bDate = b.lastCompleted?.getTime() ?? 0;
    return aDate - bDate; // Earlier last completed = more overdue
  };

  // Sort snoozed by when they'll unsnooze
  const sortBySnoozeEnd = (a: typeof tasks[0], b: typeof tasks[0]) => {
    const aDate = a.snoozedUntil?.getTime() ?? 0;
    const bDate = b.snoozedUntil?.getTime() ?? 0;
    return aDate - bDate; // Soonest to unsnooze first
  };

  grouped.today.sort(sortByDue);
  grouped.thisWeek.sort(sortByDue);
  grouped.later.sort(sortByDue);
  grouped.snoozed.sort(sortBySnoozeEnd);

  return grouped;
}

export function getTasksByRoom(state: UpkeepState) {
  const tasks = getTasksFromState(state);
  const grouped = new Map<string, typeof tasks>();

  for (const task of tasks) {
    const existing = grouped.get(task.roomId) || [];
    existing.push(task);
    grouped.set(task.roomId, existing);
  }

  return grouped;
}
