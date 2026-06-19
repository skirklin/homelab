/**
 * Selector functions for deriving views from UpkeepState.
 */
import { getUrgencyLevel, isTaskSnoozed, buildTree } from "./types";
import type { Task, TaskNode } from "./types";
import type { UpkeepState } from "./upkeep-context";

export function getTasksFromState(state: UpkeepState) {
  return Array.from(state.tasks.values());
}

/**
 * Get recurring tasks grouped by urgency (for the Kanban view). The board is
 * recurring-only and has no "asap" column — recurring tasks never produce the
 * "asap" urgency (that level is reserved for one-shot todos), so the `asap`
 * case below is unreachable here and exists only to keep the switch total.
 */
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
    // Recurring tasks can't be "asap"; fold the defensive case into "today" so
    // a future change that lets recurring tasks go asap can't silently drop them.
    if (urgency === "asap") {
      grouped.today.push(task);
      continue;
    }
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

/**
 * Build task tree from flat state (for outliner view). Excludes `cleared`
 * tasks by default — "Clear done" hides them without deletion. Pass
 * `includeCleared: true` for a future "show cleared" toggle / archive view.
 *
 * Cleared parents drop their whole subtree (a child of a cleared task is
 * orphaned and naturally excluded by buildTree). That matches the user
 * expectation that the action hides the row from view, full stop.
 */
export function getTaskTree(
  state: UpkeepState,
  { includeCleared = false }: { includeCleared?: boolean } = {},
): TaskNode[] {
  const all = getTasksFromState(state);
  const filtered = includeCleared ? all : all.filter((t) => !t.cleared);
  return buildTree(filtered);
}

/** Get tasks by tag (for trip checklists, etc.). */
export function getTasksByTag(state: UpkeepState, tag: string): Task[] {
  return getTasksFromState(state).filter((t) => t.tags.includes(tag));
}
