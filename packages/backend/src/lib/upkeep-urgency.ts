/**
 * Shared urgency projection for tasks.
 *
 * Lifted out of `apps/upkeep/app/src/types.ts` so other apps (e.g. life's
 * morning session header) can bucket tasks without cross-app imports. Typed
 * against a structural subset of the discriminated `Task` union so both the
 * backend `Task` (created/updated as strings) and the upkeep app's local
 * `Task` (createdAt/updatedAt as Dates) pass without ceremony.
 *
 * `urgencyOf(task, now)` is the single source of truth. It takes `now` as a
 * parameter (the clock used to be read independently at several call sites — a
 * latent midnight-boundary bug) and folds snooze IN, so callers can't check it
 * inconsistently.
 */

import type { Frequency } from "../types/upkeep";

/**
 * Structured urgency. Replaces the old `UrgencyLevel` enum, which conflated
 * two genuinely different one-shot states under `"asap"`: an OVERDUE dated
 * commitment (maximally urgent) and a SOMEDAY undated todo (unscheduled, not
 * urgent). The union carries the distinction so consumers don't reconstruct
 * it. `days` is the whole-day delta to the due date (overdue counts how many
 * days past; dueSoon/later how many days ahead).
 */
export type UrgencyState =
  | { kind: "overdue"; days: number }
  | { kind: "dueToday" }
  | { kind: "dueSoon"; days: number }
  | { kind: "later"; days: number }
  | { kind: "someday" }
  | { kind: "snoozed"; until: Date };

/**
 * Minimal structural shape needed to compute urgency. Mirrors the `Task` union
 * on `taskType`; both `Task` (from `@homelab/backend`) and the upkeep app's
 * local `Task` satisfy it.
 */
export type UrgencyTask =
  | {
      taskType: "recurring";
      frequency: Frequency;
      lastCompleted: Date | null;
      snoozedUntil: Date | null;
    }
  | {
      taskType: "one_shot";
      schedule: { kind: "dated"; deadline: Date; leadDays: number } | { kind: "someday" };
      completed: boolean;
      cleared: boolean;
      snoozedUntil: Date | null;
    };

/**
 * Next due date. For one-shots this is the explicit deadline (or null when
 * someday). For recurring tasks it's last_completed + frequency (null if never
 * done, which means immediately due).
 */
export function calculateDueDate(task: UrgencyTask): Date | null {
  if (task.taskType === "one_shot") {
    return task.schedule.kind === "dated" ? task.schedule.deadline : null;
  }
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

/** Whole-day difference between two dates, comparing local midnights. */
function dayDelta(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Whole-day difference between today (local midnight) and the task's due date.
 * Negative = overdue, 0 = due today. `null` when there is no due date — i.e. a
 * recurring task that's never been done, or a someday one-shot.
 *
 * Defaults `now` to the wall clock for the legacy callers that don't pass it;
 * prefer threading an explicit `now` through `urgencyOf`.
 */
export function daysUntilDue(task: UrgencyTask, now: Date = new Date()): number | null {
  const dueDate = calculateDueDate(task);
  if (!dueDate) return null;
  return dayDelta(now, dueDate);
}

export function isTaskSnoozed(task: UrgencyTask, now: Date = new Date()): boolean {
  return !!task.snoozedUntil && task.snoozedUntil.getTime() > now.getTime();
}

/**
 * The urgency projection. Snooze is folded in (a snoozed task is always
 * `{kind:"snoozed"}` regardless of deadline) so call sites can't check it
 * inconsistently. The two old `"asap"` cases split into their real meanings:
 * an overdue dated one-shot → `overdue`; an undated one-shot → `someday`.
 * Recurring tasks never produce `overdue`/`someday` — a due/overdue recurring
 * is `dueToday`, so the Kanban board's recurring-only columns are unaffected.
 */
export function urgencyOf(task: UrgencyTask, now: Date): UrgencyState {
  if (isTaskSnoozed(task, now)) {
    return { kind: "snoozed", until: task.snoozedUntil as Date };
  }

  // Undated one-shot: a genuinely unscheduled todo. Named, not inferred.
  if (task.taskType === "one_shot" && task.schedule.kind === "someday") {
    return { kind: "someday" };
  }

  const diffDays = daysUntilDue(task, now);

  // No due date here means a never-done recurring task → due now.
  if (diffDays === null) return { kind: "dueToday" };

  if (diffDays < 0) {
    // An overdue one-shot is maximally urgent; an overdue recurring is just
    // "due now" (recurring never surfaces as overdue).
    return task.taskType === "one_shot"
      ? { kind: "overdue", days: -diffDays }
      : { kind: "dueToday" };
  }
  if (diffDays === 0) return { kind: "dueToday" };
  if (diffDays <= 7) return { kind: "dueSoon", days: diffDays };
  return { kind: "later", days: diffDays };
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
export function isActionableOneShot(task: UrgencyTask, now: Date = new Date()): boolean {
  return (
    task.taskType === "one_shot" &&
    !task.completed &&
    !task.cleared &&
    !isTaskSnoozed(task, now)
  );
}
