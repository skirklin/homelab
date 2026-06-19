import type { LifeEvent, NotificationMode } from "@kirkl/shared";
import {
  calculateDueDate as sharedCalculateDueDate,
  daysUntilDue as sharedDaysUntilDue,
  urgencyOf as sharedUrgencyOf,
  isTaskSnoozed as sharedIsTaskSnoozed,
  isActionableOneShot as sharedIsActionableOneShot,
  type UrgencyState,
} from "@homelab/backend";
export type { NotificationMode, UrgencyState };

/**
 * Task completion record. Same unified shape as life events — entries[] is the
 * canonical place for per-completion data. Today we only write a single text
 * entry named "notes" (see getCompletionNotes below).
 */
export type Completion = Omit<LifeEvent, "log">;

export type FrequencyUnit = "days" | "weeks" | "months";

export interface Frequency {
  value: number;
  unit: FrequencyUnit;
}

export type TaskType = "recurring" | "one_shot";

export type {
  OneShotSchedule,
  RecurringTask as BackendRecurringTask,
  OneShotTask as BackendOneShotTask,
} from "@homelab/backend";

// Task as used in the app — same discriminated union as the backend `Task`,
// but with Date `createdAt`/`updatedAt` instead of string `created`/`updated`.
// The "someday" state is named (schedule.kind), not inferred from a null
// deadline; variant-specific fields can't be set on the wrong variant.
interface TaskBase {
  id: string;
  parentId: string;
  path: string;
  position: number;
  name: string;
  description: string;
  snoozedUntil: Date | null;
  assignees: string[];
  createdBy: string;
  tags: string[];
  collapsed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecurringTask extends TaskBase {
  taskType: "recurring";
  frequency: Frequency;
  lastCompleted: Date | null;
}

export interface OneShotTask extends TaskBase {
  taskType: "one_shot";
  schedule:
    | { kind: "dated"; deadline: Date; leadDays: number }
    | { kind: "someday" };
  completed: boolean;
  /**
   * "Clear done" hides completed one_shot tasks without deleting them.
   * Default outliner view filters these out; the row remains so the user
   * can re-show it by toggling the field off.
   */
  cleared: boolean;
}

export type Task = RecurringTask | OneShotTask;

// Tree node for outliner rendering
export interface TaskNode {
  task: Task;
  children: TaskNode[];
  depth: number;
}

export function getTaskId(completion: Completion): string {
  return completion.subjectId;
}

export function getCompletionNotes(completion: Completion): string {
  for (const e of completion.entries) {
    if (e.name === "notes" && e.type === "text") return e.value;
  }
  return "";
}

// Task list (container)
export interface TaskList {
  id: string;
  name: string;
  owners: string[];
  created: Date;
  updated: Date;
}

export type { UserProfile, UserProfileStore } from "@kirkl/shared";

// Urgency projection — canonical impl in @homelab/backend so life's morning
// header can reuse it without cross-app imports. `urgencyOf` takes `now` so the
// clock is threaded explicitly (no per-call-site midnight-boundary drift).
export const calculateDueDate = (task: Task): Date | null => sharedCalculateDueDate(task);
export const daysUntilDue = (task: Task, now: Date = new Date()): number | null =>
  sharedDaysUntilDue(task, now);
export const urgencyOf = (task: Task, now: Date = new Date()): UrgencyState =>
  sharedUrgencyOf(task, now);

/** The one-shot deadline, or null for recurring / someday tasks. */
export const taskDeadline = (task: Task): Date | null =>
  task.taskType === "one_shot" && task.schedule.kind === "dated" ? task.schedule.deadline : null;

export function formatFrequency(frequency: Frequency): string {
  const { value, unit } = frequency;
  if (value === 1) return `Every ${unit.slice(0, -1)}`;
  return `Every ${value} ${unit}`;
}

export const isTaskSnoozed = (task: Task): boolean => sharedIsTaskSnoozed(task);
export const isActionableOneShot = (task: Task): boolean => sharedIsActionableOneShot(task);

export function formatSnoozeRemaining(task: Task): string {
  if (!task.snoozedUntil) return "";
  const now = new Date();
  const diffMs = task.snoozedUntil.getTime() - now.getTime();
  if (diffMs <= 0) return "";

  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return diffDays === 1 ? "1 day" : `${diffDays} days`;
  if (diffHours > 0) return diffHours === 1 ? "1 hour" : `${diffHours} hours`;
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  return diffMinutes <= 1 ? "< 1 min" : `${diffMinutes} min`;
}

export function formatDueDate(task: Task): string {
  const dueDate = calculateDueDate(task);
  if (!dueDate) return "Never done";

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDateOnly = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
  const diffDays = Math.floor((dueDateOnly.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < -1) return `${Math.abs(diffDays)} days overdue`;
  if (diffDays === -1) return "1 day overdue";
  if (diffDays === 0) return "Due today";
  if (diffDays === 1) return "Due tomorrow";
  if (diffDays <= 7) return `Due in ${diffDays} days`;
  return `Due ${dueDate.toLocaleDateString()}`;
}

/**
 * Human-readable label for a one-shot task's deadline. Reads the dated
 * schedule directly (via `taskDeadline`, not calculateDueDate) to be explicit
 * that this is the one-shot deadline surface. Returns "" for someday/recurring.
 */
export function formatDeadline(task: Task): string {
  const deadline = taskDeadline(task);
  if (!deadline) return "";

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDateOnly = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());
  const diffDays = Math.floor((dueDateOnly.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < -1) return `${Math.abs(diffDays)} days overdue`;
  if (diffDays === -1) return "1 day overdue";
  if (diffDays === 0) return "Due today";
  if (diffDays === 1) return "Due tomorrow";
  if (diffDays <= 7) return `Due in ${diffDays} days`;
  return `Due ${deadline.toLocaleDateString()}`;
}

// Build a tree from flat task array
export function buildTree(tasks: Task[]): TaskNode[] {
  const byParent = new Map<string, Task[]>();
  for (const t of tasks) {
    const pid = t.parentId || "";
    const list = byParent.get(pid) || [];
    list.push(t);
    byParent.set(pid, list);
  }

  function buildChildren(parentId: string, depth: number): TaskNode[] {
    const children = byParent.get(parentId) || [];
    children.sort((a, b) => a.position - b.position);
    return children.map((task) => ({
      task,
      depth,
      children: buildChildren(task.id, depth + 1),
    }));
  }

  return buildChildren("", 0);
}
