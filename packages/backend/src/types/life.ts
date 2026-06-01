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

/**
 * One field of a data-defined trackable. Maps onto the unified life_events
 * shape per the manifest design (see apps/life/ROADMAP.md §2):
 *
 *   - `number` | `rating` | `text` | `bool` → a `life_events.entries[]` entry
 *     whose `name` is this field's `key`.
 *   - `category` → a `life_events.labels[key]` string value (NOT an entry).
 *
 * `key` is IMMUTABLE — it is the join key that links historical events to the
 * trackable. Renaming it silently orphans history; the P4 MCP layer enforces
 * this. Everything else (label, unit, options, defaults, order) is editable.
 */
export interface TypedField {
  /** IMMUTABLE entry name / label key — the history join key. */
  key: string;
  type: "number" | "rating" | "text" | "category" | "bool";
  label?: string;
  /** For `number` fields — storage-canonical unit ("min", "mg", "oz", "ct", …). */
  unit?: string;
  /** For `rating` fields — top of the scale (default 5). */
  scale?: number;
  /** For `category` fields — the selectable values, written into labels[key]. */
  options?: string[];
  /** Pre-filled value in the log form (canonical unit for numbers). */
  defaultValue?: number;
  /** When true the field may be omitted from a logged event. */
  optional?: boolean;
}

/**
 * A replayable quick-action payload: the exact entries[]/labels{} a one-tap
 * chip writes. `pinned[]` on a trackable holds the user's manual favorites
 * (P3 layers runtime frecency on top). `labels` here are the categorical
 * dimensions; `entries` are the measurement values.
 */
export interface QuickPayload {
  label?: string;
  entries: LifeEntry[];
  labels?: Record<string, string>;
}

/**
 * A per-user, data-defined trackable. Stored in `life_logs.manifest.trackables`.
 * Generic over field types — no code references any specific `id`. Replaces the
 * hardcoded `Trackable` in apps/life/app/src/trackables.ts as the runtime
 * source (P2); that file survives only as the default-template seed.
 *
 * `id` is IMMUTABLE — it becomes `life_events.subject_id` and is the history
 * join key. Removing a trackable from the manifest never deletes events; events
 * persist and re-link if a trackable with the same id is re-added.
 */
export interface LifeManifestTrackable {
  /** IMMUTABLE — becomes subject_id; the history join key. */
  id: string;
  label: string;
  group?: string;
  hidden?: boolean;
  fields: TypedField[];
  /** Manual quick-action favorites, shown first on the log card. */
  pinned?: QuickPayload[];
}

/**
 * The per-user trackable manifest persisted on `life_logs.manifest`. Sessions
 * are NOT in here — they stay code-defined in apps/life/.../manifest.ts.
 */
export interface LifeManifest {
  trackables: LifeManifestTrackable[];
}

export interface LifeLog {
  id: string;
  sampleSchedule: SampleSchedule | null;
  /**
   * Per-user, data-defined trackable manifest. Null on legacy logs that
   * predate the P1 backfill; new logs are seeded with the default template on
   * first `getOrCreateLog`. The app reads hardcoded `TRACKABLES` until P2
   * swaps the render path to this field.
   */
  manifest: LifeManifest | null;
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
