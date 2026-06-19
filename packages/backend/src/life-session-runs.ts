/**
 * Shared session-run normalizer for the Unified Capture model (Phase B3.3).
 *
 * A "session run" is one morning / evening / weekly reflection. On disk a run is
 * N PER-ITEM `life_events` rows — one per captured item, each under its own
 * vocab `subject_id`, correlated by `labels.view` + `labels.view_run`. This is
 * what the ViewRunner writes; the B3 fanout migration converted ALL historical
 * fat `*_session` events into this same per-item shape, so no fat events remain.
 *
 * EVERY reader — the frontend (DayTimeline / SessionStreakGrid / Journal) AND
 * the api Coach bundle — funnels its `life_events` through `normalizeSessionRuns`
 * here, which collapses the per-item stream into a uniform `SessionRun[]`.
 *
 * The shared id-map constants (`SESSION_SUBJECTS` / `SESSION_VIEW` /
 * `SESSION_ID_MAP` / `RATED_NEW_IDS`) are NO LONGER used by this read path —
 * they survive ONLY because the one-shot fanout migration
 * (`services/scripts/historical/lib/life-rewrite.ts`) re-exports them. They are
 * the single source of truth for how a legacy prompt mapped to a vocab id and
 * must stay in lockstep with that migration's planner.
 *
 * Pure: no PocketBase, no I/O, no clock. Works on a plain event shape so both
 * the camelCase frontend `LifeEvent` and the snake_case api `LifeEventRecord`
 * can be adapted into it cheaply.
 */

import type { LifeEntry } from "./types/life";

// ───────────────────────────────────────────────────────────────────────────
// The shared id-map (single source of truth for the fanout migration).
// KEPT EXPORTED for `services/scripts/historical/lib/life-rewrite.ts`, which
// re-exports these. The read path below no longer references them.
// ───────────────────────────────────────────────────────────────────────────

/** The three legacy fat session subjects the migration consumes. */
export const SESSION_SUBJECTS = [
  "morning_session",
  "evening_session",
  "weekly_review_session",
] as const;
export type SessionSubject = (typeof SESSION_SUBJECTS)[number];

/** A view id — the value written to `labels.view` and the run's `view`. */
export type SessionView = "morning" | "evening" | "weekly";

/**
 * Legacy fat session subject → its view id. NOTE weekly's view id is `weekly`
 * (matching the ViewRunner's `labels.view` and `DEFAULT_VIEWS`), NOT
 * `weekly_review`.
 */
export const SESSION_VIEW: Record<SessionSubject, SessionView> = {
  morning_session: "morning",
  evening_session: "evening",
  weekly_review_session: "weekly",
};

/**
 * The fully-decided id map (design §3 + the B1 mood decision). For each legacy
 * fat session subject, legacy `entries[].name` → the new per-item `subject_id`.
 *
 * `mood` / `mood_rating` route into the LIVE `mood` series; all others are the
 * §3 reflective vocab ids (distinct, de-collided across sessions).
 *
 * The fanout migration HARD-FAILS on any entry name not present here for its
 * subject.
 */
export const SESSION_ID_MAP: Record<SessionSubject, Record<string, string>> = {
  morning_session: {
    gratitude: "gratitude",
    intention: "daily_intention",
    energy: "energy",
  },
  evening_session: {
    win: "daily_win",
    lesson: "daily_lesson",
    intention_followup: "intention_followup",
    mood: "mood",
  },
  weekly_review_session: {
    highlights: "highlights",
    lows: "lows",
    lesson: "weekly_lesson",
    intention: "weekly_intention",
    mood_rating: "mood",
  },
};

/**
 * New per-item subject_ids whose canonical entry is the RATED shape
 * (`{name:"rating", unit:"rating", scale}`). Every other mapped id is `noted`
 * (a single `{name:"note", type:"text"}` entry).
 */
export const RATED_NEW_IDS = new Set(["energy", "mood"]);

// ───────────────────────────────────────────────────────────────────────────
// Normalizer
// ───────────────────────────────────────────────────────────────────────────

/**
 * The minimal event shape the normalizer needs. Both the frontend `LifeEvent`
 * (camelCase, `Date` timestamp) and the api `LifeEventRecord` (snake_case,
 * string timestamp) adapt into this cheaply via `toNormalizerEvent`.
 */
export interface NormalizerEvent {
  id: string;
  subjectId: string;
  /** A `Date`; the api side wraps its ISO string in `new Date(...)`. */
  timestamp: Date;
  entries: LifeEntry[];
  labels?: Record<string, string> | null;
}

/** One captured item within a run, normalized to a vocab id. */
export interface RunItem {
  /** The new vocab `subject_id` (e.g. `gratitude`, `energy`, `mood`). */
  vocabId: string;
  /** The entries[] for this item — a single `{name:"note"|"rating"}` entry. */
  entries: LifeEntry[];
}

/**
 * A normalized session run — the uniform shape every reader consumes. `values`
 * maps each captured vocab id to its items (always exactly one item per id for
 * a run; an array future-proofs a vocab captured twice in one run).
 */
export interface SessionRun {
  /** The run's view id. */
  view: SessionView;
  /** The run's representative timestamp (the per-item group's earliest child). */
  timestamp: Date;
  /** vocab id → its captured item(s) in this run. */
  values: Record<string, RunItem[]>;
  /** A stable id: `<view>:<view_run>`. */
  id: string;
}

/**
 * Canonicalize a `view_run` to an epoch instant so per-item children whose
 * `labels.view_run` differ only in string form (e.g. the migration set it to
 * the source's raw PB timestamp `"YYYY-MM-DD HH:MM:SS.mmmZ"` with a space, while
 * a fresh run sets it to an ISO string with a "T") group into the SAME run. PB's
 * space separator doesn't parse everywhere, so normalize it to "T" first.
 */
function runInstantKey(viewRun: string): string {
  const ms = Date.parse(viewRun.replace(" ", "T"));
  return Number.isNaN(ms) ? viewRun : String(ms);
}

/**
 * Collapse a `life_events` stream into uniform session runs.
 *
 * Per-item runs: events carrying `labels.view` (one of morning/evening/weekly)
 * AND `labels.view_run`, grouped by `(view, view_run)`. Each event's `subjectId`
 * is the vocab id. Events with no run signal (plain trackers, freeform journal)
 * are ignored.
 */
export function normalizeSessionRuns(events: NormalizerEvent[]): SessionRun[] {
  const runs = new Map<string, SessionRun>();
  for (const ev of events) {
    const view = ev.labels?.view as SessionView | undefined;
    const viewRun = ev.labels?.view_run;
    if (!view || !viewRun) continue;
    if (view !== "morning" && view !== "evening" && view !== "weekly") continue;
    const key = `${view} ${runInstantKey(viewRun)}`;
    let run = runs.get(key);
    if (!run) {
      run = {
        view,
        timestamp: ev.timestamp,
        values: {},
        id: `${view}:${viewRun}`,
      };
      runs.set(key, run);
    }
    // Earliest child timestamp represents the run.
    if (ev.timestamp.getTime() < run.timestamp.getTime()) run.timestamp = ev.timestamp;
    (run.values[ev.subjectId] ??= []).push({ vocabId: ev.subjectId, entries: ev.entries });
  }
  return [...runs.values()];
}

/**
 * Adapt a frontend-style camelCase event (`LifeEvent` / app `LogEvent`) into a
 * `NormalizerEvent`. Identity-ish: the frontend type already matches the shape,
 * so this is a typed passthrough that narrows `labels`.
 */
export function toNormalizerEvent(ev: {
  id: string;
  subjectId: string;
  timestamp: Date;
  entries: LifeEntry[];
  labels?: Record<string, string>;
}): NormalizerEvent {
  return {
    id: ev.id,
    subjectId: ev.subjectId,
    timestamp: ev.timestamp,
    entries: ev.entries,
    labels: ev.labels ?? null,
  };
}
