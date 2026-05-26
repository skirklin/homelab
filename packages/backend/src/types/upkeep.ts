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

export interface Task {
  id: string;
  list: string;
  parentId: string;
  path: string;
  position: number;
  name: string;
  description: string;
  taskType: TaskType;
  frequency: Frequency;
  lastCompleted: Date | null;
  completed: boolean;
  snoozedUntil: Date | null;
  notifyUsers: string[];
  createdBy: string;
  tags: string[];
  collapsed: boolean;
  /**
   * Soft-hide flag for "Clear done". When true the outliner filters the row
   * out of the default view; the row is still persisted so the action is
   * reversible. Only ever set on completed one_shot tasks — recurring tasks
   * self-reset via last_completed and are never cleared.
   */
  cleared: boolean;
  created: string;
  updated: string;
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
