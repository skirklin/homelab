import { Timestamp } from "firebase/firestore";

// Room/area definition for organizing tasks
export interface RoomDef {
  id: string;
  name: string;
}

export type RoomId = string;

export type FrequencyUnit = "days" | "weeks" | "months";

export interface Frequency {
  value: number;
  unit: FrequencyUnit;
}

// Task as used in the app (with Date objects)
export interface Task {
  id: string;
  name: string;
  description: string;
  roomId: RoomId;
  frequency: Frequency;
  lastCompleted: Date | null;
  notifyUsers: string[]; // User IDs who want notifications when task becomes due
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// Task as stored in Firestore (with Timestamps)
export interface TaskStore {
  name: string;
  description: string;
  roomId: RoomId;
  frequency: Frequency;
  lastCompleted: Timestamp | null;
  notifyUsers: string[];
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// Completion record as used in the app
export interface Completion {
  id: string;
  taskId: string;
  completedBy: string;
  completedAt: Date;
  notes: string;
}

// Completion as stored in Firestore
export interface CompletionStore {
  taskId: string;
  completedBy: string;
  completedAt: Timestamp;
  notes: string;
}

// Task list (container)
export interface TaskList {
  id: string;
  name: string;
  owners: string[];
  rooms: RoomDef[];
  created: Date;
  updated: Date;
}

export interface TaskListStore {
  name: string;
  owners: string[];
  roomDefs: RoomDef[];
  created: Timestamp;
  updated: Timestamp;
}

// User profile for tracking accessible lists via slugs
// Uses 'householdSlugs' to avoid conflict with groceries app's 'slugs' field
export interface UserProfile {
  householdSlugs: Record<string, string>;
  fcmTokens?: string[]; // FCM tokens for push notifications
}

export interface UserProfileStore {
  householdSlugs: Record<string, string>;
  fcmTokens?: string[];
}

// Urgency levels for Kanban columns
export type UrgencyLevel = "today" | "thisWeek" | "later";

// Conversion functions
export function taskFromStore(id: string, data: TaskStore): Task {
  return {
    id,
    name: data.name,
    description: data.description || "",
    roomId: data.roomId || "general",
    frequency: data.frequency,
    lastCompleted: data.lastCompleted?.toDate() ?? null,
    notifyUsers: data.notifyUsers || [],
    createdBy: data.createdBy,
    createdAt: data.createdAt.toDate(),
    updatedAt: data.updatedAt.toDate(),
  };
}

export function taskToStore(task: Omit<Task, "id">): TaskStore {
  return {
    name: task.name,
    description: task.description,
    roomId: task.roomId,
    frequency: task.frequency,
    lastCompleted: task.lastCompleted ? Timestamp.fromDate(task.lastCompleted) : null,
    notifyUsers: task.notifyUsers || [],
    createdBy: task.createdBy,
    createdAt: Timestamp.fromDate(task.createdAt),
    updatedAt: Timestamp.fromDate(task.updatedAt),
  };
}

export function completionFromStore(id: string, data: CompletionStore): Completion {
  return {
    id,
    taskId: data.taskId,
    completedBy: data.completedBy,
    completedAt: data.completedAt.toDate(),
    notes: data.notes || "",
  };
}

export function listFromStore(id: string, data: TaskListStore): TaskList {
  return {
    id,
    name: data.name,
    owners: data.owners,
    rooms: data.roomDefs || [],
    created: data.created.toDate(),
    updated: data.updated.toDate(),
  };
}

// Utility: calculate next due date
export function calculateDueDate(task: Task): Date | null {
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

// Utility: determine urgency level
export function getUrgencyLevel(task: Task): UrgencyLevel {
  const now = new Date();
  const dueDate = calculateDueDate(task);

  // Never completed = due today (most urgent)
  if (!dueDate) return "today";

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDateOnly = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
  const diffDays = Math.floor((dueDateOnly.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return "today"; // Past due or due today
  if (diffDays <= 7) return "thisWeek";
  return "later";
}

// Utility: format frequency for display
export function formatFrequency(frequency: Frequency): string {
  const { value, unit } = frequency;
  if (value === 1) {
    // Singular form
    return `Every ${unit.slice(0, -1)}`;
  }
  return `Every ${value} ${unit}`;
}

// Utility: format due date for display
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
