import type { Event, EventStore, NotificationMode } from "@kirkl/shared";
export type { Event, EventStore, NotificationMode };

export type FrequencyUnit = "days" | "weeks" | "months";

export interface Frequency {
  value: number;
  unit: FrequencyUnit;
}

export type TaskType = "recurring" | "one_shot";

// Task as used in the app (with Date objects)
export interface Task {
  id: string;
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
  createdAt: Date;
  updatedAt: Date;
}

// Tree node for outliner rendering
export interface TaskNode {
  task: Task;
  children: TaskNode[];
  depth: number;
}

// Completion record (uses unified Event type)
export type Completion = Event;

export function getTaskId(completion: Event): string {
  return completion.subjectId;
}

export function getCompletionNotes(completion: Event): string {
  return (completion.data.notes as string) ?? "";
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

// Urgency levels for Kanban columns
export type UrgencyLevel = "today" | "thisWeek" | "later";

// Utility: calculate next due date (only meaningful for recurring tasks)
export function calculateDueDate(task: Task): Date | null {
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

export function getUrgencyLevel(task: Task): UrgencyLevel {
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

export function formatFrequency(frequency: Frequency): string {
  const { value, unit } = frequency;
  if (value === 1) return `Every ${unit.slice(0, -1)}`;
  return `Every ${value} ${unit}`;
}

export function isTaskSnoozed(task: Task): boolean {
  if (!task.snoozedUntil) return false;
  return task.snoozedUntil.getTime() > Date.now();
}

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
