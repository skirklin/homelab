/**
 * Selector functions for deriving views from UpkeepState.
 */
import { getUrgencyLevel, isTaskSnoozed, buildTree } from "./types";
import type { Task, TaskNode } from "./types";
import type { UpkeepState } from "./upkeep-context";

export function getTasksFromState(state: UpkeepState) {
  return Array.from(state.tasks.values());
}

/** Get recurring tasks grouped by urgency (for Kanban view). */
export function getTasksByUrgency(state: UpkeepState) {
  const tasks = getTasksFromState(state).filter((t) => t.taskType === "recurring");
  const grouped = {
    today: [] as Task[],
    thisWeek: [] as Task[],
    later: [] as Task[],
    snoozed: [] as Task[],
  };

  for (const task of tasks) {
    if (isTaskSnoozed(task)) {
      grouped.snoozed.push(task);
      continue;
    }
    const urgency = getUrgencyLevel(task);
    grouped[urgency].push(task);
  }

  const sortByDue = (a: Task, b: Task) => {
    const aDate = a.lastCompleted?.getTime() ?? 0;
    const bDate = b.lastCompleted?.getTime() ?? 0;
    return aDate - bDate;
  };

  const sortBySnoozeEnd = (a: Task, b: Task) => {
    const aDate = a.snoozedUntil?.getTime() ?? 0;
    const bDate = b.snoozedUntil?.getTime() ?? 0;
    return aDate - bDate;
  };

  grouped.today.sort(sortByDue);
  grouped.thisWeek.sort(sortByDue);
  grouped.later.sort(sortByDue);
  grouped.snoozed.sort(sortBySnoozeEnd);

  return grouped;
}

/** Build task tree from flat state (for outliner view). */
export function getTaskTree(state: UpkeepState): TaskNode[] {
  return buildTree(getTasksFromState(state));
}

/** Get tasks by tag (for trip checklists, etc.). */
export function getTasksByTag(state: UpkeepState, tag: string): Task[] {
  return getTasksFromState(state).filter((t) => t.tags.includes(tag));
}
