// Local re-exports so app code imports a single in-app symbol instead of
// reaching across the backend boundary on every line.
export type { LifeEvent as LogEvent, LifeEntry, LifeLog, SampleSchedule } from "@homelab/backend";
import type { LifeEvent } from "@homelab/backend";

// Alias kept for grep convenience — the original `LogEntry` name leaned on the
// old "one row = one entry" mental model. With the new shape one row carries
// many entries, so the row is the "event". `LogEvent` is the new alias above;
// `LogEntry` still resolves to the same row type until callers are migrated.
export type LogEntry = LifeEvent;

export function generateEventId(): string {
  return `entry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
