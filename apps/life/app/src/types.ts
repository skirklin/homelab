// Local re-exports so app code imports a single in-app symbol instead of
// reaching across the backend boundary on every line. `LogEvent` is the one
// in-app name for a logged row (it carries many entries under the shape model).
export type { LifeEvent as LogEvent, LifeEntry, LifeLog, SampleSchedule } from "@homelab/backend";

export function generateEventId(): string {
  return `entry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
