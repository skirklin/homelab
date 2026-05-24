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

export type UrgencyLevel = "today" | "thisWeek" | "later";

/**
 * Minimal shape needed to compute urgency. Both `Task` (from `@homelab/backend`)
 * and the upkeep app's local `Task` satisfy this.
 */
export interface UrgencyTask {
  taskType: TaskType;
  frequency: Frequency;
  lastCompleted: Date | null;
  snoozedUntil: Date | null;
}

/** Next due date for a recurring task. `null` for one-shots or never-completed. */
export function calculateDueDate(task: UrgencyTask): Date | null {
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

export function getUrgencyLevel(task: UrgencyTask): UrgencyLevel {
  const now = new Date();
  const dueDate = calculateDueDate(task);

  if (!dueDate) return "today"; // Never completed = due today
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDateOnly = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
  const diffDays = Math.floor((dueDateOnly.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return "today";
  if (diffDays <= 7) return "thisWeek";
  return "later";
}

export function isTaskSnoozed(task: UrgencyTask): boolean {
  if (!task.snoozedUntil) return false;
  return task.snoozedUntil.getTime() > Date.now();
}
