import type { User } from "firebase/auth";
import { Timestamp } from "firebase/firestore";

// Auth state
export interface AuthState {
  user: User | null | undefined; // undefined = loading
}

// Life Tracker Types
export type ActivityType = "sleep" | "gym" | "stretch" | "work";

export interface LogEntry {
  id: string;
  type: ActivityType;
  startTime: Date;
  endTime: Date | null;
  duration: number | null; // minutes
  notes: string;
  createdBy: string;
  createdAt: Date;
}

export interface LogEntryStore {
  type: ActivityType;
  startTime: Timestamp;
  endTime: Timestamp | null;
  duration: number | null;
  notes: string;
  createdBy: string;
  createdAt: Timestamp;
}

export interface LifeLog {
  id: string;
  name: string;
  owners: string[];
  created: Date;
  updated: Date;
}

export interface LifeLogStore {
  name: string;
  owners: string[];
  created: Timestamp;
  updated: Timestamp;
}

// Conversion functions
export function entryFromStore(id: string, data: LogEntryStore): LogEntry {
  return {
    id,
    type: data.type,
    startTime: data.startTime.toDate(),
    endTime: data.endTime?.toDate() ?? null,
    duration: data.duration,
    notes: data.notes || "",
    createdBy: data.createdBy,
    createdAt: data.createdAt.toDate(),
  };
}

export function logFromStore(id: string, data: LifeLogStore): LifeLog {
  return {
    id,
    name: data.name,
    owners: data.owners,
    created: data.created.toDate(),
    updated: data.updated.toDate(),
  };
}

// Utility functions
export function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function getActivityIcon(type: ActivityType): string {
  switch (type) {
    case "sleep": return "🌙";
    case "gym": return "💪";
    case "stretch": return "🧘";
    case "work": return "💼";
  }
}

export function getActivityLabel(type: ActivityType): string {
  switch (type) {
    case "sleep": return "Sleep";
    case "gym": return "Gym";
    case "stretch": return "Stretch";
    case "work": return "Work";
  }
}

export function getActivityColor(type: ActivityType): string {
  switch (type) {
    case "sleep": return "var(--color-sleep)";
    case "gym": return "var(--color-gym)";
    case "stretch": return "var(--color-stretch)";
    case "work": return "var(--color-work)";
  }
}
