/**
 * Selector functions for deriving views from UpkeepState.
 */
import { urgencyOf, buildTree } from "./types";
import type { Task, RecurringTask, TaskNode } from "./types";
import type { UpkeepState } from "./upkeep-context";

export function getTasksFromState(state: UpkeepState) {
  return Array.from(state.tasks.values());
}

/**
 * Get recurring tasks grouped by Kanban column (for the board). The board is
 * recurring-only, so the only `UrgencyState` kinds that can occur are
 * `dueToday` / `dueSoon` / `later` / `snoozed` — `overdue` and `someday` are
 * one-shot-only and the union proves they can't appear here.
 */
export function getTasksByUrgency(state: UpkeepState) {
  const tasks = getTasksFromState(state).filter(
    (t): t is RecurringTask => t.taskType === "recurring",
  );
  const grouped = {
    today: [] as Task[],
    thisWeek: [] as Task[],
    later: [] as Task[],
    snoozed: [] as Task[],
  };

  const now = new Date();
  for (const task of tasks) {
    const u = urgencyOf(task, now);
    switch (u.kind) {
      case "snoozed":
        grouped.snoozed.push(task);
        break;
      case "dueSoon":
        grouped.thisWeek.push(task);
        break;
      case "later":
        grouped.later.push(task);
        break;
      // dueToday — and the overdue/someday cases that recurring can't produce
      // (folded in defensively so a future model change can't silently drop them).
      default:
        grouped.today.push(task);
    }
  }

  const sortByDue = (a: Task, b: Task) => {
    const aDate = a.taskType === "recurring" ? a.lastCompleted?.getTime() ?? 0 : 0;
    const bDate = b.taskType === "recurring" ? b.lastCompleted?.getTime() ?? 0 : 0;
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
  // Only one-shot tasks can be cleared; recurring never carry the flag.
  const filtered = includeCleared
    ? all
    : all.filter((t) => !(t.taskType === "one_shot" && t.cleared));
  return buildTree(filtered);
}

/** Get tasks by tag (for trip checklists, etc.). */
export function getTasksByTag(state: UpkeepState, tag: string): Task[] {
  return getTasksFromState(state).filter((t) => t.tags.includes(tag));
}
