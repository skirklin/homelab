import type { Event, EventStore } from "@kirkl/shared";
export type { Event, EventStore };
export { eventFromStore, eventToStore } from "@kirkl/shared";

// Re-exported from @homelab/backend so the api scheduler, the PB mapper, and
// the life UI all share one source of truth for the sample-prompt schedule.
export type { SampleSchedule, LifeLog } from "@homelab/backend";

/**
 * A persisted event row, the only data shape this app deals with.
 * Subject_id is the trackable id (manifest.ts). Data shape varies but the
 * EventLogger writes `{ value, category?, intensity?, notes?, end_time? }`.
 * Legacy rows (old combo / counter-group / __sample__) are normalized by
 * lib/legacy-adapter.ts before display.
 */
export type LogEntry = Event;

export function getSource(entry: Event): "manual" | "sample" {
  return (entry.data.source as "manual" | "sample") ?? "manual";
}

export function getNotes(entry: Event): string | undefined {
  return entry.data.notes as string | undefined;
}

export function generateEntryId(): string {
  return `entry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
