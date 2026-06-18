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
 * The event-recording shapes. A shape implies the input fields and the
 * canonical entries[] a NEW event carries (readers must stay name-agnostic —
 * history uses older names like dose/volume/drinks/intensity):
 *
 *   took     → [{name:"amount",   type:"number", value, unit}]
 *   did      → [{name:"duration", type:"number", value, unit:"min"},
 *               optional {name:"rating", type:"number", unit:"rating", scale:5},
 *               optional {name:"notes",  type:"text"}]
 *   happened → [{name:"count",    type:"number", value:1, unit:"ct"}]
 *   rated    → [{name:"rating",   type:"number", unit:"rating", scale:N}]
 *   noted    → [{name:"note",     type:"text",   value}]
 *
 * `noted` is the REFLECTIVE shape — free text, no measurement. Aggregation
 * skips text entries, so noted vocab never affects charts/goals/streaks. It is
 * also the one shape EXCLUDED from every input/replay surface (the 2×2 grid,
 * the global quick row, frecency chips, the habit board long-tail): replaying
 * free text is meaningless, and noted vocab is captured only inside Views (see
 * `isReflective`/`isInputEligible` in apps/life/.../lib/shapes.ts).
 */
export type TrackableShape = "took" | "did" | "happened" | "rated" | "noted";

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
 * A template reference: when a vocab row is rendered inside a View, its
 * `prompt`/`hint` text may carry `{token}` placeholders that are filled from
 * the user's own recent history. Each ref pulls the most recent event for
 * `fromTrackable` within `within` (the owner-local day or week), reads the
 * `entry` (defaulting per shape), and substitutes it for `{token}`.
 *
 * Carried on the vocab row but UNUSED by capture in Phase A — the View renderer
 * (Phase B) consumes it. Round-trips through the PB mapper + manifest ops here.
 */
export interface TemplateRef {
  /** `{token}` placeholder in the prompt/hint/banner text. */
  token: string;
  /** A vocab id to pull a recent value from. */
  fromTrackable: string;
  /** Owner-local lookback window. */
  within: "day" | "week";
  /** Entry name to pull; defaults per the source shape when omitted. */
  entry?: string;
}

/**
 * A vocabulary row: a per-user, data-defined "thing" the user logs. Stored in
 * `life_logs.manifest.trackables`. The thing IS the event subject
 * (thing-as-subject): `id` becomes `life_events.subject_id`, so existing
 * history needs no migration when the input UI changes.
 *
 * `id` and `shape` are IMMUTABLE — `id` is the history join key, and `shape`
 * decides which entries[] a new event carries (changing it would fork the
 * series' shape mid-history). Everything else is a prefill/display hint.
 * Removing a trackable from the manifest never deletes events; events persist
 * and re-link if a trackable with the same id is re-added.
 */
export interface LifeManifestTrackable {
  /** IMMUTABLE — becomes subject_id; the history join key. */
  id: string;
  label: string;
  /** IMMUTABLE — which of the four shape widgets logs this thing. */
  shape: TrackableShape;
  /** Semantic rollup (e.g. walk/run/bike share group "exercise"). */
  group?: string;
  /** Prefill hint: unit for `took` amounts ("mg", "oz", "drinks", …). */
  defaultUnit?: string;
  /** Prefill hint: amount for `took`. */
  defaultAmount?: number;
  /** Prefill hint: duration in minutes for `did`. */
  defaultDuration?: number;
  /** Display label for the `did` shape's optional 1–5 rating ("intensity",
   *  "quality"). Absent → the rating input is not offered for this thing. */
  ratingLabel?: string;
  hidden?: boolean;
  /** Manual quick-action favorites, shown first in the quick row / sheet. */
  pinned?: QuickPayload[];
  /**
   * View-render metadata (UNUSED by capture in Phase A; consumed by the View
   * renderer in Phase B). The question text shown when this row is captured
   * inside a View. May contain `{token}`s resolved against `refs`.
   */
  prompt?: string;
  /** View-render sub-label; may contain `{token}`s. Phase-B only. */
  hint?: string;
  /** View-render input placeholder (the textarea's empty-state ghost text,
   *  byte-faithful to today's session prompt `placeholder`). Phase-B only. */
  placeholder?: string;
  /** Template references for `{token}`s in `prompt`/`hint`. Phase-B only. */
  refs?: TemplateRef[];
}

/**
 * A View is a named, ordered set of capture items rendered for human input —
 * the unifying primitive of the Unified Capture redesign. Today's morning /
 * evening / weekly *sessions* are Views rendered `guided`; the dashboard's
 * inline shape-grid is conceptually a View rendered `inline`. One renderer.
 *
 * Stored on `life_logs.manifest.views`. UNUSED by any live surface in Phase B1
 * (sessions still run the old `SessionRunner`/`SESSIONS` path) — the data model
 * lands first, the ViewRunner consumes it in Phase B2.
 */
export interface LifeView {
  /** IMMUTABLE — runner slug; written to `life_events.labels.view`. */
  id: string;
  title: string;
  /** One-line greeting shown at the top of a guided run. */
  greeting?: string;
  /** Icon hint for the View card (e.g. "sun" / "moon" / "calendar"). */
  icon?: string;
  /** "guided" = stepped wizard (sessions); "inline" = the dashboard surface. */
  render?: "guided" | "inline";
  items: LifeViewItem[];
}

/**
 * One renderable item in a View. A discriminated union on `kind`:
 *   - `capture`  — prompt the user to log a vocab row. The prompt/hint/refs
 *                  live on the VOCAB row (`LifeManifestTrackable`), not here;
 *                  this item only names the `trackableId` and whether it may be
 *                  skipped. A required (`optional` falsy) capture whose vocab
 *                  prompt has an unresolvable required ref is dropped by the
 *                  renderer (preserving today's no-nudge behavior).
 *   - `tasks_due` — a declarative header echoing upkeep tasks due today (today's
 *                  MorningUpkeepHeader). Writes no event.
 *   - `banner`   — a read-only templated echo ("This week: {wk}"). Writes no
 *                  event; drops silently if a required `refs` token is absent.
 *
 * Renderer contract (Phase B2): non-capture blocks render BEFORE the first
 * capture step, matching today's wizard layout.
 */
export type LifeViewItem =
  | { kind: "capture"; trackableId: string; optional?: boolean }
  | { kind: "tasks_due" }
  | { kind: "banner"; text: string; refs: TemplateRef[] };

/**
 * A scheduled nudge that targets a View. Decoupled from View *content* — a View
 * defines WHAT to capture; a notification defines WHEN to open it. Stored on
 * `life_logs.manifest.notifications`. UNUSED by the cron in Phase B1 — the
 * strategy dispatch (fixed + random + `subsumes` + per-user reminder-time
 * reconciliation) is Phase B4.
 */
export interface LifeNotification {
  /** IMMUTABLE — keys `reminder_state`. */
  id: string;
  /** The View id to open when the nudge fires. */
  target: string;
  strategy: LifeNotifyStrategy;
  /** Defaults to true when omitted. */
  enabled?: boolean;
}

/**
 * How a notification decides when to fire:
 *   - `fixed`  — a wall-clock time on a daily/weekly cadence. `weekday`
 *                (0 = Sunday) pins a weekly cadence to one day. `subsumes`
 *                lists notification ids this one REPLACES on its day (the weekly
 *                review subsumes the evening reminder on Sunday).
 *   - `random` — random sampling: `timesPerDay` pushes spread across
 *                `activeHours` ([startHour, endHour], 24h local). Reproduces the
 *                `RANDOM_SAMPLES` behavior; gated by `random_sampling_enabled`.
 */
export type LifeNotifyStrategy =
  | {
      kind: "fixed";
      cadence: "daily" | "weekly";
      /** "HH:MM" 24h local. */
      time: string;
      /** 0 = Sunday … 6 = Saturday. Only meaningful for cadence "weekly". */
      weekday?: number;
      /** Notification ids this one replaces on its day. */
      subsumes?: string[];
    }
  | {
      kind: "random";
      timesPerDay: number;
      /** [startHour, endHour] 24h local, inclusive start / exclusive end. */
      activeHours: [number, number];
    };

/**
 * What a goal measures over its qualifying events:
 *   "count" → number of qualifying events in the period
 *   "sum"   → sum of the qualifying number entry selected by `unit`
 *             (name-agnostic — picks every number entry whose `unit` matches)
 *   "days"  → count of DISTINCT local-tz days in the period with ≥1 event
 */
export type LifeGoalMetric = "count" | "sum" | "days";

/**
 * Comparison kind:
 *   "at_least"  → met when value ≥ target (build a habit up)
 *   "at_most"   → met when value ≤ target (the ONLY "≤" kind; a cap)
 *   "frequency" → "N days per period" — forces metric "days", met when ≥ target
 */
export type LifeGoalKind = "at_least" | "at_most" | "frequency";

/** What the goal interprets: a single vocab id, or every member of a group. */
export type LifeGoalScope = { thing: string } | { group: string };

/**
 * A goal is a THIN interpretive layer over existing `life_events` — it adds NO
 * new event data and lives in the manifest JSON next to `trackables`. It names
 * a slice of events (its `scope`), a period, and a target, and the pure
 * evaluator (apps/life/.../lib/goals.ts) reports adherence. `id` is the
 * immutable join key (so a goal can be referenced over time); everything else
 * but scope/kind/metric is freely patchable.
 */
export interface LifeGoal {
  /** IMMUTABLE slug — stable identity for the goal across edits. */
  id: string;
  label: string;
  /** A vocab id (`{thing}`) or a group name (`{group}`) to interpret. */
  scope: LifeGoalScope;
  kind: LifeGoalKind;
  metric: LifeGoalMetric;
  target: number;
  /**
   * REQUIRED when metric === "sum": selects which number entry to sum,
   * name-agnostically by unit (mg/oz/min/drinks/ct/…). Ignored otherwise.
   */
  unit?: string;
  /** "day" = the local day; "week" = the local week containing the ref date. */
  period: "day" | "week";
  hidden?: boolean;
}

/**
 * The per-user trackable manifest persisted on `life_logs.manifest`. Sessions
 * are NOT in here — they stay code-defined in apps/life/.../manifest.ts.
 * `goals` is an OPTIONAL thin interpretive layer over existing events; legacy
 * manifests predate it and read as `undefined`.
 */
export interface LifeManifest {
  trackables: LifeManifestTrackable[];
  goals?: LifeGoal[];
  /**
   * The user's capture Views (the Unified Capture primitive). RESOLVE SEMANTICS
   * (see `useViews`): `undefined` → fall back to `DEFAULT_VIEWS` (legacy logs
   * and new logs that haven't customized); `[]` → explicitly NO views (Angela);
   * a non-empty array → exactly those. Distinguishing `undefined` from `[]` is
   * load-bearing, so the PB mapper carries an explicit `[]` through verbatim.
   * UNUSED by any live surface in Phase B1.
   */
  views?: LifeView[];
  /**
   * The user's scheduled nudges. Same RESOLVE SEMANTICS as `views`
   * (`undefined` → `DEFAULT_NOTIFICATIONS`; `[]` → explicitly none). UNUSED by
   * the cron in Phase B1 (Phase B4 wires strategy dispatch).
   */
  notifications?: LifeNotification[];
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
