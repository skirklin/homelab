/**
 * Shared session-run normalizer for the Unified Capture cutover (Phase B3.2).
 *
 * A "session run" is one morning / evening / weekly reflection. Through the
 * cutover, a run exists on disk in EITHER of two shapes:
 *
 *   - FAT (legacy): a single `*_session` event whose `entries[]` carries every
 *     prompt, keyed by the legacy `entries[].name`. This is what B2 writes and
 *     what all of history holds until the §4 fanout migration runs.
 *   - PER-ITEM (new): N events, one per captured item, each under its own vocab
 *     `subject_id`, correlated by `labels.view` + `labels.view_run`. This is
 *     what B3.2's ViewRunner writes and what the migration converts history to.
 *
 * EVERY reader — the frontend (DayTimeline / SessionStreakGrid / Journal) AND
 * the api Coach bundle — must render a run IDENTICALLY regardless of shape. So
 * they all funnel their `life_events` through `normalizeSessionRuns` here, which
 * collapses both shapes into one uniform `SessionRun[]`. This is the ONE place
 * that understands the fat↔per-item duality; readers never branch on it.
 *
 * The legacy-name → vocab-id map (`SESSION_ID_MAP`) is the SAME map the B3.1
 * fanout migration uses (it re-exports from here), so the write path, the
 * migration, and the read path can never diverge on how a prompt maps to a
 * vocab id.
 *
 * Pure: no PocketBase, no I/O, no clock. Works on a plain event shape so both
 * the camelCase frontend `LifeEvent` and the snake_case api `LifeEventRecord`
 * can be adapted into it cheaply.
 */

import type { LifeEntry } from "./types/life";

// ───────────────────────────────────────────────────────────────────────────
// The shared id-map (single source of truth for write / migration / read).
// ───────────────────────────────────────────────────────────────────────────

/** The three fat session subjects the cutover consumes. */
export const SESSION_SUBJECTS = [
  "morning_session",
  "evening_session",
  "weekly_review_session",
] as const;
export type SessionSubject = (typeof SESSION_SUBJECTS)[number];

/** A view id — the value written to `labels.view` and the run's `view`. */
export type SessionView = "morning" | "evening" | "weekly";

/**
 * Fat session subject → its view id. NOTE weekly's view id is `weekly` (matching
 * the ViewRunner's `labels.view` and `DEFAULT_VIEWS`), NOT `weekly_review`.
 */
export const SESSION_VIEW: Record<SessionSubject, SessionView> = {
  morning_session: "morning",
  evening_session: "evening",
  weekly_review_session: "weekly",
};

/**
 * The fully-decided id map (design §3 + the B1 mood decision). For each fat
 * session subject, legacy `entries[].name` → the new per-item `subject_id`.
 *
 * `mood` / `mood_rating` route into the LIVE `mood` series; all others are the
 * §3 reflective vocab ids (distinct, de-collided across sessions).
 *
 * The fanout migration HARD-FAILS on any entry name not present here for its
 * subject; the normalizer simply skips unmapped names (a reader must never
 * crash on unexpected legacy data — it renders what it understands).
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
  /** The run's representative timestamp (the fat event's, or the per-item
   *  group's earliest child). */
  timestamp: Date;
  /** vocab id → its captured item(s) in this run. */
  values: Record<string, RunItem[]>;
  /** A stable id: the fat event's id, or `<view>:<view_run>` for per-item. */
  id: string;
  /** Where the run came from — `fat` (legacy event) or `per-item` (new). */
  source: "fat" | "per-item";
}

/** Build the inverse map: fat subject → (legacy name → vocab id), the same as
 *  SESSION_ID_MAP. Exposed so callers (e.g. the synthesize bridge) can reuse it. */
export const FAT_NAME_TO_VOCAB = SESSION_ID_MAP;

/**
 * Normalize a legacy fat-session entry into the canonical per-item entry for its
 * new subject id — mirrors the migration's `normalizeEntry` so a fat run reads
 * identically to its migrated per-item equivalent. RATED ids →
 * `{name:"rating", unit:"rating", scale}`; everything else → `{name:"note"}`.
 *
 * Returns null when a RATED id has a non-finite value (garbage) so the reader
 * drops it rather than surfacing NaN.
 */
function normalizeFatEntry(vocabId: string, src: LifeEntry): LifeEntry | null {
  if (RATED_NEW_IDS.has(vocabId)) {
    const value = src.type === "number" ? src.value : Number((src as { value: unknown }).value);
    if (!Number.isFinite(value)) return null;
    const scale = src.type === "number" ? src.scale ?? 5 : 5;
    return { name: "rating", type: "number", value, unit: "rating", scale };
  }
  const value = src.type === "text" ? src.value : String((src as { value: unknown }).value);
  return { name: "note", type: "text", value };
}

/**
 * Collapse a mixed `life_events` stream into uniform session runs.
 *
 * Two run shapes are recognized and merged:
 *
 *   - PER-ITEM runs: events carrying `labels.view` (one of morning/evening/
 *     weekly) AND `labels.view_run`, grouped by `(view, view_run)`. Each event's
 *     `subjectId` is the vocab id.
 *   - FAT runs: each `*_session` event, mapped through `SESSION_ID_MAP`.
 *     `weekly_review_session` → view `weekly`.
 *
 * DEDUP (the transient window while the migration runs): a fat run and a
 * per-item run for the same run describe the SAME thing — the per-item is the
 * migrated form, so the fat one is DROPPED. The collision key is
 * `view + " " + <instant>` where `<instant>` is the run's epoch-ms via
 * `runInstantKey` — canonicalized so the fat side (the event timestamp's ISO
 * string) and the per-item side (`labels.view_run`, which the migration sets to
 * the source's raw PB timestamp string) compare equal despite differing string
 * representations of the same instant.
 *
 * Unmapped fat entry names are skipped (readers never crash on unexpected data).
 * Events with no run signal (plain trackers, freeform journal) are ignored.
 */
/**
 * Canonicalize a `view_run` (or fat event timestamp) to an epoch instant so the
 * per-item side (`labels.view_run`, which the migration sets to the source's raw
 * PB timestamp string `"YYYY-MM-DD HH:MM:SS.mmmZ"` with a space) and the fat side
 * (`ev.timestamp.toISOString()`, with a "T") dedup to the SAME key despite
 * differing string forms of the same instant. PB's space separator doesn't parse
 * everywhere, so normalize it to "T" first.
 */
function runInstantKey(viewRun: string): string {
  const ms = Date.parse(viewRun.replace(" ", "T"));
  return Number.isNaN(ms) ? viewRun : String(ms);
}

export function normalizeSessionRuns(events: NormalizerEvent[]): SessionRun[] {
  // 1. Per-item runs, keyed by (view, run-instant).
  const perItem = new Map<string, SessionRun>();
  for (const ev of events) {
    const view = ev.labels?.view as SessionView | undefined;
    const viewRun = ev.labels?.view_run;
    if (!view || !viewRun) continue;
    if (view !== "morning" && view !== "evening" && view !== "weekly") continue;
    const key = `${view} ${runInstantKey(viewRun)}`;
    let run = perItem.get(key);
    if (!run) {
      run = {
        view,
        timestamp: ev.timestamp,
        values: {},
        id: `${view}:${viewRun}`,
        source: "per-item",
      };
      perItem.set(key, run);
    }
    // Earliest child timestamp represents the run.
    if (ev.timestamp.getTime() < run.timestamp.getTime()) run.timestamp = ev.timestamp;
    (run.values[ev.subjectId] ??= []).push({ vocabId: ev.subjectId, entries: ev.entries });
  }

  // 2. Fat runs, mapped through SESSION_ID_MAP — dropped when a per-item run
  //    already covers the same (view, view_run=timestamp ISO).
  const fat: SessionRun[] = [];
  for (const ev of events) {
    if (!(SESSION_SUBJECTS as readonly string[]).includes(ev.subjectId)) continue;
    const subject = ev.subjectId as SessionSubject;
    const view = SESSION_VIEW[subject];
    const dedupKey = `${view} ${runInstantKey(ev.timestamp.toISOString())}`;
    if (perItem.has(dedupKey)) continue; // migrated -> the per-item run wins.

    const map = SESSION_ID_MAP[subject];
    const values: Record<string, RunItem[]> = {};
    for (const entry of ev.entries) {
      const vocabId = map[entry.name];
      if (!vocabId) continue; // unmapped legacy name → skip (don't crash).
      const normalized = normalizeFatEntry(vocabId, entry);
      if (!normalized) continue;
      (values[vocabId] ??= []).push({ vocabId, entries: [normalized] });
    }
    fat.push({
      view,
      timestamp: ev.timestamp,
      values,
      id: ev.id,
      source: "fat",
    });
  }

  return [...perItem.values(), ...fat];
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
