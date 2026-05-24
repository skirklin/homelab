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

/**
 * A single named typed value captured during a life event.
 *
 * Storage is canonical (durations in minutes, doses in mg, etc.); the UI does
 * friendly display via apps/life/.../lib/format.ts. Aggregation behaviour is
 * derived from `unit` (rating → avg, everything else → sum). See the migration
 * 20260522_221157_life_event_unified_shape.js header for the full unit table.
 */
export type LifeEntry =
  | {
      name: string;
      type: "number";
      value: number;
      /**
       * Storage-canonical unit. Common values:
       *   "min"     durations
       *   "mg"      doses
       *   "oz"      volumes
       *   "drinks"  alcoholic drinks
       *   "ct"      count of discrete things
       *   "rating"  1..scale rating (companion `scale` field; default 5)
       */
      unit: string;
      /** Required for unit="rating", optional otherwise. Defaults to 5 if omitted. */
      scale?: number;
    }
  | {
      name: string;
      type: "text";
      value: string;
    }
  | {
      /**
       * Boolean state entry. No current callers, but the variant is here so
       * future state-toggle events (e.g. "did the thing today") can land
       * without another type-level migration. The PB column is plain JSON, so
       * we don't need a schema change to start writing these.
       */
      name: string;
      type: "bool";
      value: boolean;
    };

/**
 * A persisted life_events row. One event per moment in time per subject_id;
 * its `entries[]` carries every named value captured (one or many).
 *
 * `labels` are k8s-style categorical dimensions (free-form strings). Stable
 * conventions today:
 *   source         "manual" | "sample" | "journey" | "wearable" | "import"
 *   category       free-form per subject (replaces the old data.category)
 *   tz             IANA timezone of the logger at write time
 *   journey_id     foreign key for Journey backfill idempotency
 *   location_lat/lon/address, weather/weather_place — Journey-era enrichment
 *
 * `endTime` is reserved for interval-style logging (timer mode, wearable
 * imports). Today's entries leave it undefined.
 */
export interface LifeEvent {
  id: string;
  log: string;
  /** Trackable / session id (see apps/life/.../manifest.ts). */
  subjectId: string;
  timestamp: Date;
  /** Reserved for interval events (sleep, workouts). Undefined for point events. */
  endTime?: Date;
  entries: LifeEntry[];
  labels?: Record<string, string>;
  createdBy: string;
  created: string;
  updated: string;
}
