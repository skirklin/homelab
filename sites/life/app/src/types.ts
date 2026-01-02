import { Timestamp } from "firebase/firestore";
import type { Event, EventStore } from "@kirkl/shared";
export type { Event, EventStore };
export { eventFromStore, eventToStore } from "@kirkl/shared";

// ============================================
// Widget Types
// ============================================

export type WidgetType = "counter" | "number" | "rating" | "text" | "combo";

export interface BaseWidget {
  id: string;
  label: string;
}

export interface CounterWidget extends BaseWidget {
  type: "counter";
}

export interface NumberWidget extends BaseWidget {
  type: "number";
  min?: number;
  max?: number;
  unit?: string;
}

export interface RatingWidget extends BaseWidget {
  type: "rating";
  max: number; // e.g., 5 for 5-star rating
}

export interface TextWidget extends BaseWidget {
  type: "text";
  placeholder?: string;
  multiline?: boolean;
}

export interface ComboField {
  id: string;
  label: string;
  type: "number" | "rating" | "text";
  min?: number;
  max?: number;
  unit?: string;
  placeholder?: string;
}

export interface ComboWidget extends BaseWidget {
  type: "combo";
  fields: ComboField[];
}

export type Widget =
  | CounterWidget
  | NumberWidget
  | RatingWidget
  | TextWidget
  | ComboWidget;

// ============================================
// Random Sampling Configuration
// ============================================

export interface SampleQuestion {
  id: string;
  type: "rating" | "text" | "number";
  label: string;
  max?: number;
  min?: number;
  placeholder?: string;
}

export interface RandomSamplesConfig {
  enabled: boolean;
  timesPerDay: number;
  activeHours: [number, number]; // [startHour, endHour] in 24h format
  questions: SampleQuestion[];
}

// ============================================
// Manifest
// ============================================

export interface LifeManifest {
  widgets: Widget[];
  randomSamples: RandomSamplesConfig;
}

export const DEFAULT_MANIFEST: LifeManifest = {
  widgets: [
    { id: "meds", type: "counter", label: "Meds" },
    { id: "vitamins", type: "counter", label: "Vitamins" },
    { id: "sleep", type: "combo", label: "Sleep", fields: [
      { id: "hours", type: "number", label: "Hours", min: 0, max: 24 },
      { id: "quality", type: "rating", label: "Quality", max: 5 },
    ]},
  ],
  randomSamples: {
    enabled: false,
    timesPerDay: 3,
    activeHours: [9, 22],
    questions: [
      { id: "mood", type: "rating", label: "How are you feeling?", max: 5 },
    ],
  },
};

// ============================================
// Log Entry (now uses unified Event type)
// ============================================

// LogEntry is now an alias for Event with life-specific data
// Event.data contains: { source?: "manual" | "sample", notes?: string, ...widgetData }
// Event.subjectId is the widgetId
export type LogEntry = Event;

// Helper to get widgetId from an event
export function getWidgetId(entry: Event): string {
  return entry.subjectId;
}

// Helper to get source from event data
export function getSource(entry: Event): "manual" | "sample" {
  return (entry.data.source as "manual" | "sample") ?? "manual";
}

// Helper to get notes from event data
export function getNotes(entry: Event): string | undefined {
  return entry.data.notes as string | undefined;
}

// ============================================
// Life Log Container
// ============================================

export interface LifeLog {
  id: string;
  name: string;
  owners: string[];
  manifest: LifeManifest;
  created: Date;
  updated: Date;
}

export interface LifeLogStore {
  name: string;
  owners: string[];
  manifest?: LifeManifest;
  created: Timestamp;
  updated: Timestamp;
}

// ============================================
// Conversion Functions
// ============================================

export function logFromStore(id: string, data: LifeLogStore): LifeLog {
  return {
    id,
    name: data.name,
    owners: data.owners,
    manifest: data.manifest ?? DEFAULT_MANIFEST,
    created: data.created.toDate(),
    updated: data.updated.toDate(),
  };
}

// ============================================
// Utility Functions
// ============================================

export function getWidget(manifest: LifeManifest, id: string): Widget | undefined {
  return manifest.widgets.find(w => w.id === id);
}

export function generateWidgetId(): string {
  return `widget-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function generateEntryId(): string {
  return `entry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function getTodayCount(entries: LogEntry[], widgetId: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return entries.filter(e =>
    e.subjectId === widgetId &&
    e.timestamp >= today
  ).length;
}

/**
 * Get entries for a widget on a specific date.
 * If targetDate is undefined, uses today.
 */
export function getEntriesForDate(
  entries: LogEntry[],
  widgetId: string,
  targetDate?: Date
): LogEntry[] {
  const date = targetDate ?? new Date();
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  return entries.filter(e =>
    e.subjectId === widgetId &&
    e.timestamp >= startOfDay &&
    e.timestamp <= endOfDay
  );
}

/**
 * Get count of entries for a widget on a specific date.
 * If targetDate is undefined, uses today.
 */
export function getCountForDate(
  entries: LogEntry[],
  widgetId: string,
  targetDate?: Date
): number {
  return getEntriesForDate(entries, widgetId, targetDate).length;
}
