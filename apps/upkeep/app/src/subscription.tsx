/**
 * PocketBase real-time subscriptions for the upkeep app.
 * Replaces Firestore onSnapshot listeners with PocketBase SSE subscriptions.
 */
import { getBackend } from "@kirkl/shared";
import { eventFromStore } from "@kirkl/shared";
import { setCurrentListId, ensureListExists, getUserSlugs } from "./pocketbase";
import { taskFromRecord, listFromRecord } from "./types";
import type { Completion } from "./types";
import type { UpkeepState, UpkeepAction } from "./upkeep-context";

type Dispatch = React.Dispatch<UpkeepAction>;

function pb() {
  return getBackend();
}

export async function loadUserSlugs(userId: string, dispatch: Dispatch, cancelled: () => boolean) {
  try {
    const slugs = await getUserSlugs(userId, { $autoCancel: false });
    if (cancelled()) return;
    dispatch({ type: "SET_USER_SLUGS", slugs });
  } catch (err) {
    console.error("[upkeep] loadUserSlugs failed:", err);
  }
}

export function subscribeToUserSlugs(userId: string, dispatch: Dispatch, cancelled: () => boolean): () => void {
  // Load initial slugs
  loadUserSlugs(userId, dispatch, cancelled).catch(console.error);

  // Subscribe to user record changes
  pb().collection("users").subscribe(userId, (e) => {
    if (cancelled()) return;
    dispatch({
      type: "SET_USER_SLUGS",
      slugs: e.record.household_slugs || {},
    });
  });

  return () => {
    pb().collection("users").unsubscribe(userId);
  };
}

export async function subscribeToList(
  listId: string,
  userId: string,
  dispatch: Dispatch,
  cancelled: () => boolean
): Promise<Array<() => void>> {
  setCurrentListId(listId);

  // Clear previous list data
  dispatch({ type: "CLEAR_TASKS" });
  dispatch({ type: "SET_LIST", list: null });
  dispatch({ type: "SET_LOADING", loading: true });

  await ensureListExists(userId);
  if (cancelled()) return [];

  const unsubscribers: Array<() => void> = [];

  // Load initial list data — disable auto-cancel to prevent React re-render races
  const opts = { $autoCancel: false };
  try {
    const list = await pb().collection("task_lists").getOne(listId, opts);
    if (cancelled()) return unsubscribers;
    dispatch({ type: "SET_LIST", list: listFromRecord(list) });
  } catch {
    if (cancelled()) return unsubscribers;
    dispatch({ type: "SET_LIST", list: null });
  }

  // Subscribe to list changes
  pb().collection("task_lists").subscribe(listId, (e) => {
    if (cancelled()) return;
    if (e.action === "delete") {
      dispatch({ type: "SET_LIST", list: null });
    } else {
      dispatch({ type: "SET_LIST", list: listFromRecord(e.record) });
    }
  });
  unsubscribers.push(() => pb().collection("task_lists").unsubscribe(listId));

  // Load initial tasks
  try {
    const tasks = await pb().collection("tasks").getFullList({
      filter: `list = "${listId}"`,
      $autoCancel: false,
    });
    if (cancelled()) return unsubscribers;
    for (const task of tasks) {
      dispatch({ type: "SET_TASK", task: taskFromRecord(task) });
    }
  } catch (e) {
    console.error("Failed to load tasks:", e);
  }
  if (cancelled()) return unsubscribers;
  dispatch({ type: "SET_LOADING", loading: false });

  // Subscribe to task changes
  pb().collection("tasks").subscribe("*", (e) => {
    if (cancelled()) return;
    if (e.record.list !== listId) return;
    if (e.action === "delete") {
      dispatch({ type: "REMOVE_TASK", taskId: e.record.id });
    } else {
      dispatch({ type: "SET_TASK", task: taskFromRecord(e.record) });
    }
  });
  unsubscribers.push(() => pb().collection("tasks").unsubscribe("*"));

  // Load initial completions (most recent 100)
  try {
    const events = await pb().collection("task_events").getList(1, 100, {
      filter: `list = "${listId}"`,
      sort: "-timestamp",
      $autoCancel: false,
    });
    if (cancelled()) return unsubscribers;
    const completions: Completion[] = events.items.map((record) =>
      eventFromStore(record.id, {
        subject_id: record.subject_id,
        timestamp: record.timestamp,
        created_by: record.created_by,
        data: record.data || {},
        created: record.created,
      })
    );
    dispatch({ type: "SET_COMPLETIONS", completions });
  } catch (e) {
    console.error("Failed to load completions:", e);
  }

  // Subscribe to event changes
  pb().collection("task_events").subscribe("*", (e) => {
    if (cancelled()) return;
    if (e.record.list !== listId) return;
    // Reload all events on any change (simpler than incremental updates)
    pb().collection("task_events").getList(1, 100, {
      filter: `list = "${listId}"`,
      sort: "-timestamp",
      $autoCancel: false,
    }).then((events) => {
      if (cancelled()) return;
      const completions: Completion[] = events.items.map((record) =>
        eventFromStore(record.id, {
          subject_id: record.subject_id,
          timestamp: record.timestamp,
          created_by: record.created_by,
          data: record.data || {},
          created: record.created,
        })
      );
      dispatch({ type: "SET_COMPLETIONS", completions });
    }).catch(console.error);
  });
  unsubscribers.push(() => pb().collection("task_events").unsubscribe("*"));

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

// Re-import from types for use in getTasksByUrgency
import { getUrgencyLevel, isTaskSnoozed } from "./types";
