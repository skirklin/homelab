/** Upkeep (household tasks) domain types */

import type { Event } from "./common";

export interface TaskList {
  id: string;
  name: string;
  owners: string[];
  rooms: RoomDef[];
}

export interface RoomDef {
  id: string;
  name: string;
  icon?: string;
}

export interface Frequency {
  value: number;
  unit: "days" | "weeks" | "months";
}

export interface Task {
  id: string;
  list: string;
  name: string;
  description: string;
  roomId: string;
  frequency: Frequency;
  lastCompleted: Date | null;
  snoozedUntil: Date | null;
  notifyUsers: string[];
}

export type TaskCompletion = Event;
