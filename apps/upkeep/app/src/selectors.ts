/**
 * Selector functions for deriving views from UpkeepState.
 */
import { urgencyOf, buildTree, groupTaskIds } from "./types";
import type { Task, RecurringTask, TaskNode } from "./types";
import type { UpkeepState } from "./upkeep-context";

export function getTasksFromState(state: UpkeepState) {
  return Array.from(state.tasks.values());
}

/**
 * Get recurring LEAF tasks grouped by Kanban column (for the board). Surfaces
 * only leaves — a recurring task that HAS children is a structural container
 * and is excluded, the SAME leaf/group rule the notification crons and life's
 * morning block use (`groupTaskIds`). Group-ness is computed over the COMPLETE
 * task universe since a child can be any task_type.
 *
 * The board is recurring-only, so the only `UrgencyState` kinds that can occur
 * are `dueToday` / `dueSoon` / `later` / `snoozed` — `overdue` and `someday`
 * are one-shot-only and the union proves they can't appear here.
 */
export function getTasksByUrgency(state: UpkeepState) {
  const all = getTasksFromState(state);
  const groupIds = groupTaskIds(all);
  const tasks = all.filter(
    (t): t is RecurringTask => t.taskType === "recurring" && !groupIds.has(t.id),
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

/**
 * Group tasks by their `parentId` in a single O(n) pass. Keyed by the raw
 * `parentId` string (`""` for roots). Within each bucket, sibling ORDER is
 * exactly the iteration order of the input array — i.e. identical to what
 * `tasks.filter((t) => t.parentId === pid)` would have produced. Callers that
 * need positional order still sort by `position` themselves (same as before).
 */
export function childrenByParentId(tasks: Task[]): Map<string, Task[]> {
  const byParent = new Map<string, Task[]>();
  for (const t of tasks) {
    const list = byParent.get(t.parentId);
    if (list) list.push(t);
    else byParent.set(t.parentId, [t]);
  }
  return byParent;
}

/**
 * All descendant IDs of `rootId` (including itself), via the grouped-children
 * map — O(subtree size). Returns the same id set as a brute-force scan that
 * re-walks the full task array per node. Returns `[]` if `rootId` is unknown.
 */
export function subtreeIds(
  childrenMap: Map<string, Task[]>,
  tasksById: Map<string, Task>,
  rootId: string,
): string[] {
  if (!tasksById.has(rootId)) return [];
  const result = [rootId];
  const stack = [rootId];
  while (stack.length) {
    const pid = stack.pop()!;
    const children = childrenMap.get(pid);
    if (!children) continue;
    for (const child of children) {
      result.push(child.id);
      stack.push(child.id);
    }
  }
  return result;
}
