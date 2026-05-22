/** Life tracker domain types */

/**
 * Per-day schedule of random-sample prompt times for a life log.
 * Stored on `life_logs.sample_schedule` (JSON), regenerated daily by the
 * api-service cron in the user's configured timezone.
 */
export interface SampleSchedule {
  /** YYYY-MM-DD in the schedule's timezone */
  date: string;
  /** Unix-ms timestamps for each scheduled prompt */
  times: number[];
  /** Subset of `times` that have already triggered a push */
  sentTimes: number[];
}

export interface LifeLog {
  id: string;
  sampleSchedule: SampleSchedule | null;
  /**
   * Per-log opt-in for the api service's per-5-minute random-sample cron in
   * `services/api/src/lib/notifications/life.ts`. When false (the default for
   * newly-created logs), no random check-in pushes are sent and no
   * `sample_schedule` is generated. Morning/evening/weekly session reminders
   * are gated independently by their `*ReminderTime` fields being non-null.
   *
   * Always defined after the PB mapper runs — the field defaults to `false`
   * in PocketBase, the mapper coerces any falsy value to `false`.
   */
  randomSamplingEnabled: boolean;
  /** "HH:MM" 24h string, or null/undefined when no morning reminder is set. */
  morningReminderTime?: string | null;
  /** "HH:MM" 24h string, or null/undefined when no evening reminder is set. */
  eveningReminderTime?: string | null;
  /** "HH:MM" 24h string for the weekly review reminder (fires Sunday). Null
   *  or undefined disables it. */
  weeklyReminderTime?: string | null;
  /** "YYYY-MM-DD" in the user's tz — last day a weekly review push went
   *  out. Server-side idempotency for the Sunday cron. */
  lastWeeklyReminderSent?: string | null;
  created: string;
  updated: string;
}

export interface LifeEntry {
  id: string;
  log: string;
  widgetId: string;
  timestamp: Date;
  createdBy: string;
  data: Record<string, unknown>;
  notes?: string;
  created: string;
  updated: string;
}
