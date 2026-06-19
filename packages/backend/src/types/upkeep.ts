/** Upkeep / unified task system domain types */

import type { LifeEntry } from "./life";

export interface TaskList {
  id: string;
  name: string;
  owners: string[];
  created: string;
  updated: string;
}

export interface Frequency {
  value: number;
  unit: "days" | "weeks" | "months";
}

export type TaskType = "recurring" | "one_shot";

/**
 * Fields every task carries regardless of variant.
 *
 * `list`/`created`/`updated` are server-stamped read fields; they live here
 * (not in the write-side patch) so a subscribed `Task` always carries them.
 */
export interface TaskBase {
  id: string;
  list: string;
  parentId: string;
  path: string;
  position: number;
  name: string;
  description: string;
  snoozedUntil: Date | null;
  /** Users the task is assigned to — the sole notification driver. */
  assignees: string[];
  /** Immutable provenance: who created the task. Cascade's terminal floor. */
  createdBy: string;
  tags: string[];
  collapsed: boolean;
  created: string;
  updated: string;
}

export interface RecurringTask extends TaskBase {
  taskType: "recurring";
  frequency: Frequency;
  /** Last completion timestamp; null = never done (immediately due). */
  lastCompleted: Date | null;
}

/**
 * A one-shot's schedule. The discriminant NAMES the "someday" state that used
 * to be inferred from `deadline === null` — an undated todo is genuinely
 * "unscheduled", not the same thing as an overdue dated commitment. The PB→TS
 * mapper is the single choke point that derives this from the flat
 * `deadline` / `deadline_lead_days` columns (wire format unchanged).
 */
export type OneShotSchedule =
  | {
      kind: "dated";
      deadline: Date;
      /** Remind this many days before the deadline (0 = day-of + overdue). */
      leadDays: number;
    }
  | { kind: "someday" };

export interface OneShotTask extends TaskBase {
  taskType: "one_shot";
  schedule: OneShotSchedule;
  completed: boolean;
  /**
   * Soft-hide flag for "Clear done". When true the outliner filters the row
   * out of the default view; the row is still persisted so the action is
   * reversible. Only ever set on completed one_shot tasks — recurring tasks
   * self-reset via last_completed and are never cleared.
   */
  cleared: boolean;
}

/**
 * Discriminated on `taskType`. The union makes variant-specific fields
 * unsettable on the wrong variant (a recurring task has no `schedule`; a
 * one-shot has no `frequency`) and names the "someday" state instead of
 * inferring it from `deadline === null`.
 */
export type Task = RecurringTask | OneShotTask;

/**
 * Flat write-side patch for `updateTask`. Distinct from the read-side `Task`
 * union: the PB mapper accepts any subset of columns, and a flat patch dodges
 * `Partial<A | B>` distribution. `deadline: null` clears the deadline (→
 * someday); `taskType` switches the variant.
 */
export interface TaskUpdate {
  name: string;
  description: string;
  taskType: TaskType;
  frequency: Frequency;
  lastCompleted: Date | null;
  deadline: Date | null;
  deadlineLeadDays: number | null;
  completed: boolean;
  snoozedUntil: Date | null;
  assignees: string[];
  tags: string[];
  collapsed: boolean;
  cleared: boolean;
  position: number;
  parentId: string;
}

/**
 * A persisted task_events row. Same unified shape as LifeEvent, minus the
 * `log` container field (task events live under a `list` instead). Notes are
 * carried as a text entry, e.g.:
 *   { name: "notes", type: "text", value: "looks great" }
 */
export interface TaskCompletion {
  id: string;
  subjectId: string;
  timestamp: Date;
  /** Reserved for interval completions; unused today. */
  endTime?: Date;
  entries: LifeEntry[];
  labels?: Record<string, string>;
  createdBy: string;
  created: string;
  updated: string;
}
