import { Timestamp } from "firebase/firestore";

// Activity definition - customizable by user
export interface ActivityDef {
  id: string;
  label: string;
  icon: string;
  color: string;
}

// Default activities for new logs
export const DEFAULT_ACTIVITIES: ActivityDef[] = [
  { id: "sleep", label: "Sleep", icon: "🌙", color: "#8b5cf6" },
  { id: "gym", label: "Gym", icon: "💪", color: "#ef4444" },
  { id: "stretch", label: "Stretch", icon: "🧘", color: "#10b981" },
  { id: "work", label: "Work", icon: "💼", color: "#3b82f6" },
];

// Log entry as used in the app (with Date objects)
export interface LogEntry {
  id: string;
  activityId: string;
  startTime: Date;
  endTime: Date | null;
  duration: number | null; // minutes
  notes: string;
  createdBy: string;
  createdAt: Date;
}

// Log entry as stored in Firestore (with Timestamps)
export interface LogEntryStore {
  activityId: string;
  startTime: Timestamp;
  endTime: Timestamp | null;
  duration: number | null;
  notes: string;
  createdBy: string;
  createdAt: Timestamp;
}

// Life log container
export interface LifeLog {
  id: string;
  name: string;
  owners: string[];
  activities: ActivityDef[];
  created: Date;
  updated: Date;
}

export interface LifeLogStore {
  name: string;
  owners: string[];
  activities?: ActivityDef[];
  created: Timestamp;
  updated: Timestamp;
}

// Conversion functions
export function entryFromStore(id: string, data: LogEntryStore): LogEntry {
  return {
    id,
    activityId: data.activityId,
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
    activities: data.activities ?? DEFAULT_ACTIVITIES,
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

// Get activity by ID from a list of activities
export function getActivity(activities: ActivityDef[], id: string): ActivityDef | undefined {
  return activities.find(a => a.id === id);
}

// Generate a unique ID for a new activity
export function generateActivityId(): string {
  return `activity-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
