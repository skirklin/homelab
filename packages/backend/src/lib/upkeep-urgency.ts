/**
 * Shared urgency helpers for recurring tasks.
 *
 * Lifted out of `apps/upkeep/app/src/types.ts` so other apps (e.g. life's
 * morning session header) can bucket tasks without cross-app imports. Typed
 * against a structural subset so both the backend `Task` (created/updated as
 * strings) and the upkeep app's local `Task` (createdAt/updatedAt as Dates)
 * pass without ceremony.
 */

import type { Frequency, TaskType } from "../types/upkeep";

/**
 * Urgency buckets, most-urgent first. `asap` is the top bucket and applies ONLY
 * to one-shot todos that need attention now: those with no deadline at all (an
 * open todo that would otherwise silently rot in "later") or one whose deadline
 * has already passed (overdue). Recurring tasks never produce `asap` — their
 * "due now" state is `today`.
 */
export type UrgencyLevel = "asap" | "today" | "thisWeek" | "later";

/**
 * Minimal shape needed to compute urgency. Both `Task` (from `@homelab/backend`)
 * and the upkeep app's local `Task` satisfy this.
 */
export interface UrgencyTask {
  taskType: TaskType;
  frequency: Frequency;
  lastCompleted: Date | null;
  deadline: Date | null;
  snoozedUntil: Date | null;
  completed: boolean;
  cleared: boolean;
}

/**
 * Next due date. For one-shots this is the explicit `deadline` (or null).
 * For recurring tasks it's last_completed + frequency (null if never done).
 */
export function calculateDueDate(task: UrgencyTask): Date | null {
  if (task.taskType === "one_shot") return task.deadline ?? null;
  if (task.taskType !== "recurring") return null;
  if (!task.lastCompleted) return null; // Never done = immediately due

  const due = new Date(task.lastCompleted);
  switch (task.frequency.unit) {
    case "days":
      due.setDate(due.getDate() + task.frequency.value);
      break;
    case "weeks":
      due.setDate(due.getDate() + task.frequency.value * 7);
      break;
    case "months":
      due.setMonth(due.getMonth() + task.frequency.value);
      break;
  }
  return due;
}

/**
 * Whole-day difference between today (local midnight) and the task's due date.
 * Negative = overdue, 0 = due today. `null` when there is no due date — i.e. a
 * recurring task that's never been done, or a one-shot with no deadline.
 */
export function daysUntilDue(task: UrgencyTask): number | null {
  const dueDate = calculateDueDate(task);
  if (!dueDate) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDateOnly = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
  return Math.floor((dueDateOnly.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export function getUrgencyLevel(task: UrgencyTask): UrgencyLevel {
  const diffDays = daysUntilDue(task);

  // No due date: a never-done recurring task is due today; a one-shot WITHOUT a
  // deadline is "asap" — it has no scheduled prompt and used to rot silently in
  // "later" (matched no notification path), so the user could forget it forever.
  if (diffDays === null) return task.taskType === "recurring" ? "today" : "asap";

  // An overdue one-shot (deadline already passed) is also "asap" — it's past
  // due and needs action now. Recurring overdue stays "today" (recurring never
  // produces "asap", so the Kanban board's recurring-only columns are unaffected).
  if (diffDays < 0) return task.taskType === "one_shot" ? "asap" : "today";

  if (diffDays === 0) return "today";
  if (diffDays <= 7) return "thisWeek";
  return "later";
}

export function isTaskSnoozed(task: UrgencyTask): boolean {
  if (!task.snoozedUntil) return false;
  return task.snoozedUntil.getTime() > Date.now();
}

/**
 * Is this an open one-shot todo worth surfacing right now? True for a one_shot
 * that is not completed, not cleared ("Clear done" soft-hide), and not snoozed.
 *
 * This is the gate every "actionable todo" UI shares — upkeep's outliner row
 * badges and life's "tasks due" block. Snooze lives IN the predicate (all call
 * sites exclude snoozed), so callers don't re-spell the boolean chain. It does
 * NOT consider urgency level or deadline — layer those on at the call site.
 */
export function isActionableOneShot(task: UrgencyTask): boolean {
  return (
    task.taskType === "one_shot" &&
    !task.completed &&
    !task.cleared &&
    !isTaskSnoozed(task)
  );
}
