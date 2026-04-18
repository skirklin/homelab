/** Upkeep / unified task system domain types */

import type { Event } from "./common";

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
  created: string;
  updated: string;
}

export type TaskCompletion = Event;
