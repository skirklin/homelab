/**
 * Selector functions for deriving views from UpkeepState.
 */
import { getUrgencyLevel, isTaskSnoozed } from "./types";
import type { UpkeepState } from "./upkeep-context";

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
