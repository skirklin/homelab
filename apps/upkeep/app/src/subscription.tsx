/**
 * PocketBase real-time subscriptions for the upkeep app.
 * Replaces Firestore onSnapshot listeners with PocketBase SSE subscriptions.
 */
import {
  eventFromStore,
  subscribeToRecord,
  subscribeToCollection,
  subscribeToCollectionReload,
} from "@kirkl/shared";
import type { RecordModel } from "pocketbase";
import { setCurrentListId, ensureListExists } from "./pocketbase";
import { taskFromRecord, listFromRecord } from "./types";
import type { Completion } from "./types";
import type { UpkeepState, UpkeepAction } from "./upkeep-context";

type Dispatch = React.Dispatch<UpkeepAction>;

function recordsToCompletions(records: RecordModel[]): Completion[] {
  return records.map((record) =>
    eventFromStore(record.id, {
      subject_id: record.subject_id,
      timestamp: record.timestamp,
      created_by: record.created_by,
      data: record.data || {},
      created: record.created,
    })
  );
}

export function subscribeToUserSlugs(userId: string, dispatch: Dispatch, cancelled: () => boolean): () => void {
  return subscribeToRecord("users", userId, cancelled, {
    onData: (record) => {
      dispatch({ type: "SET_USER_SLUGS", slugs: record.household_slugs || {} });
    },
    onError: (err) => {
      console.error("[upkeep] loadUserSlugs failed:", err);
    },
  });
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

  // Subscribe to list metadata
  unsubscribers.push(
    subscribeToRecord("task_lists", listId, cancelled, {
      onData: (record) => {
        dispatch({ type: "SET_LIST", list: listFromRecord(record) });
      },
      onDelete: () => {
        dispatch({ type: "SET_LIST", list: null });
      },
      onError: () => {
        dispatch({ type: "SET_LIST", list: null });
      },
    })
  );

  // Subscribe to tasks
  unsubscribers.push(
    subscribeToCollection("tasks", cancelled, {
      filter: `list = "${listId}"`,
      belongsTo: (r) => r.list === listId,
      onInitial: (records) => {
        for (const task of records) {
          dispatch({ type: "SET_TASK", task: taskFromRecord(task) });
        }
        dispatch({ type: "SET_LOADING", loading: false });
      },
      onChange: (action, record) => {
        if (action === "delete") {
          dispatch({ type: "REMOVE_TASK", taskId: record.id });
        } else {
          dispatch({ type: "SET_TASK", task: taskFromRecord(record) });
        }
      },
      onError: (e) => {
        console.error("Failed to load tasks:", e);
      },
    })
  );

  // Subscribe to completions (most recent 100, reload on any change)
  unsubscribers.push(
    subscribeToCollectionReload("task_events", cancelled, {
      filter: `list = "${listId}"`,
      sort: "-timestamp",
      page: 1,
      perPage: 100,
      belongsTo: (r) => r.list === listId,
      onInitial: (records) => {
        dispatch({ type: "SET_COMPLETIONS", completions: recordsToCompletions(records) });
      },
      onAnyChange: (records) => {
        dispatch({ type: "SET_COMPLETIONS", completions: recordsToCompletions(records) });
      },
      onError: (e) => {
        console.error("Failed to load completions:", e);
      },
    })
  );

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
