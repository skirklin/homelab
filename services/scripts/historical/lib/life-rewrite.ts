/**
 * Pure transform logic for the 2026-06 life-tracker history rewrites:
 *
 *   1. merge-sleep-quality.ts — fold standalone `sleep_quality` events into
 *      the same local day's `sleep` event as a `rating` entry.
 *   2. split-category-subjects.ts — split category-shaped subjects
 *      (`exercise`, `focus`) into per-thing subjects derived from
 *      `labels.category`, renaming `intensity` → `rating`.
 *   3. fanout-session-events.ts — fan each fat `*_session` event OUT into N
 *      per-item `life_events` rows (one per prompt entry), then delete the
 *      source. The Phase-B3.1 cutover from one-fat-event sessions to the
 *      per-item, label-correlated View model.
 *
 * Everything here is pure (no PocketBase, no I/O) so it can be unit-tested
 * directly — see life-rewrite.test.ts. The scripts own auth + fetch + apply.
 */

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export type Entry =
  | { name: string; type: "number"; value: number; unit?: string; scale?: number }
  | { name: string; type: "text"; value: string };

export interface EventRow {
  id: string;
  subject_id: string;
  /** PB timestamp string, e.g. "2026-03-04 07:30:00.000Z". */
  timestamp: string;
  /** Optional PB end_time for span events. */
  end_time?: string;
  entries: Entry[];
  labels: Record<string, string> | null;
  created_by?: string;
}

// ---------------------------------------------------------------------------
// Day bucketing
// ---------------------------------------------------------------------------

export const DEFAULT_TZ = "America/Los_Angeles";

/**
 * Return `tz` if Intl accepts it as a timezone, else `fallback`. Mirrors
 * `safeTz` in services/api/src/lib/notifications/tz.ts (which validates via
 * date-fns-tz; we use bare Intl to avoid a new dependency here).
 */
export function safeTz(tz: unknown, fallback: string = DEFAULT_TZ): string {
  if (typeof tz !== "string" || !tz) return fallback;
  try {
    new Date().toLocaleDateString("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

/**
 * The calendar day a timestamp falls on in `tz`, as `YYYY-MM-DD`.
 *
 * Same reduction as `todayPacific` in services/api/src/lib/notifications/tz.ts
 * (`en-CA` yields the ISO shape), parameterized by the log owner's timezone.
 * PB stores timestamps as "YYYY-MM-DD HH:MM:SS.mmmZ" — the space separator is
 * not guaranteed to parse everywhere, so normalize it to a "T".
 */
export function localDayKey(timestamp: string, tz: string): string {
  const d = new Date(timestamp.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Unparseable timestamp: ${JSON.stringify(timestamp)}`);
  }
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

// ---------------------------------------------------------------------------
// Script 1: merge sleep_quality into sleep
// ---------------------------------------------------------------------------

/** Minutes of sleep recorded on an event: the `duration` entry (minutes),
 *  falling back to `end_time - timestamp` when there's no duration entry. */
export function sleepDurationMinutes(ev: EventRow): number {
  const dur = ev.entries.find((e) => e.name === "duration" && e.type === "number");
  if (dur && dur.type === "number") return dur.value;
  if (ev.end_time) {
    const ms = Date.parse(ev.end_time.replace(" ", "T")) - Date.parse(ev.timestamp.replace(" ", "T"));
    if (Number.isFinite(ms) && ms > 0) return Math.round(ms / 60000);
  }
  return 0;
}

/** A rating pulled off a quality event. `unit`/`scale` are carried from the
 *  source entry when present; absent means "use the defaults" (rating / 5). */
export interface RatingValue {
  value: number;
  unit?: string;
  scale?: number;
}

export type RatingExtract =
  /** Found a rating. `extras` = the event's other entries (the rating's
   *  source entry excluded, so a fallback-named entry isn't duplicated). */
  | { kind: "rating"; rating: RatingValue; extras: Entry[] }
  /** Nothing rating-shaped on the event → safe to skip. */
  | { kind: "none"; reason: string }
  /** A lone numeric entry that does NOT look like a rating → conflict, the
   *  operator must look at it (it would otherwise be silently mis-read). */
  | { kind: "not-rating"; reason: string };

/**
 * Pull the rating out of a sleep_quality event: the entry named `rating`,
 * else a single numeric entry — but only if it plausibly IS a rating
 * (unit "rating", or unitless integer 1–5). unit/scale ride along verbatim.
 */
export function extractRating(ev: EventRow): RatingExtract {
  const named = ev.entries.find((e) => e.name === "rating" && e.type === "number");
  if (named && named.type === "number") {
    return {
      kind: "rating",
      rating: { value: named.value, unit: named.unit, scale: named.scale },
      extras: ev.entries.filter((e) => e !== named),
    };
  }
  const numeric = ev.entries.filter((e) => e.type === "number");
  if (numeric.length === 0) {
    return { kind: "none", reason: "no numeric rating entry on sleep_quality event" };
  }
  if (numeric.length > 1) {
    return { kind: "none", reason: `ambiguous: ${numeric.length} numeric entries, none named "rating"` };
  }
  const only = numeric[0];
  if (only.type !== "number") return { kind: "none", reason: "unreachable" };
  const looksLikeRating =
    only.unit === "rating" ||
    (only.unit === undefined && Number.isInteger(only.value) && only.value >= 1 && only.value <= 5);
  if (!looksLikeRating) {
    return {
      kind: "not-rating",
      reason: `single numeric entry "${only.name}" does not look like a rating (unit=${only.unit ?? "none"}, value=${only.value})`,
    };
  }
  return {
    kind: "rating",
    rating: { value: only.value, unit: only.unit, scale: only.scale },
    extras: ev.entries.filter((e) => e !== only),
  };
}

/** Materialize a RatingValue as an entry; defaults apply only when absent. */
function ratingEntry(r: RatingValue): Entry {
  return { name: "rating", type: "number", value: r.value, unit: r.unit ?? "rating", scale: r.scale ?? 5 };
}

/** Deep equality on entries (unit/scale included for numbers). */
export function entryEqual(a: Entry, b: Entry): boolean {
  if (a.name !== b.name || a.type !== b.type || a.value !== b.value) return false;
  if (a.type === "number" && b.type === "number") {
    return (a.unit ?? null) === (b.unit ?? null) && (a.scale ?? null) === (b.scale ?? null);
  }
  return true;
}

/** Does the target's named rating entry match the incoming rating, with
 *  defaults applied on BOTH sides? A 4/10 is never identical to a 4/5. */
function sameRating(target: Entry, incoming: RatingValue): boolean {
  if (target.type !== "number") return false;
  return (
    target.value === incoming.value &&
    (target.unit ?? "rating") === (incoming.unit ?? "rating") &&
    (target.scale ?? 5) === (incoming.scale ?? 5)
  );
}

type Labels = Record<string, string>;

/** Merge incoming labels into target labels. A key present on both with a
 *  differing value is a clash (caller plans a conflict). */
function mergeLabels(
  target: Labels | null,
  incoming: Labels | null,
): { merged: Labels | null; changed: boolean; clashKey?: string } {
  if (!incoming || Object.keys(incoming).length === 0) {
    return { merged: target, changed: false };
  }
  const merged: Labels = { ...(target ?? {}) };
  let changed = false;
  for (const [k, v] of Object.entries(incoming)) {
    if (k in merged) {
      if (merged[k] !== v) return { merged: target, changed: false, clashKey: k };
    } else {
      merged[k] = v;
      changed = true;
    }
  }
  return { merged: changed ? merged : target, changed };
}

/** Every incoming label already present deep-equal on the target. */
function labelsAlreadyOn(target: Labels | null, incoming: Labels | null): boolean {
  if (!incoming) return true;
  return Object.entries(incoming).every(([k, v]) => (target ?? {})[k] === v);
}

export type SleepMergeAction =
  /** PATCH the sleep event (entries, plus labels/end_time when carried),
   *  then DELETE the quality event. */
  | {
      kind: "attach";
      day: string;
      qualityId: string;
      sleepId: string;
      rating: number;
      newEntries: Entry[];
      /** Set when quality labels merged in (full merged value to PATCH). */
      newLabels?: Labels;
      /** Set when the quality's end_time is carried onto the sleep event. */
      newEndTime?: string;
      /** Names of non-rating entries carried over from the quality event. */
      carried: string[];
    }
  /** No sleep that day: CREATE a sleep event, then DELETE the quality event. */
  | {
      kind: "create";
      day: string;
      qualityId: string;
      rating: number;
      event: {
        subject_id: "sleep";
        timestamp: string;
        end_time?: string;
        entries: Entry[];
        labels: Labels | null;
        created_by?: string;
      };
    }
  /** EVERYTHING the quality event carries (rating incl. unit/scale, extras,
   *  labels, end_time) is already present deep-equal on the target sleep —
   *  e.g. a previous run died between PATCH and DELETE: just DELETE it. */
  | { kind: "delete-only"; day: string; qualityId: string; sleepId: string; rating: number }
  /** Report + leave both events untouched. */
  | { kind: "conflict"; day: string; qualityId: string; sleepId?: string; reason: string }
  | { kind: "skip"; day: string; qualityId: string; reason: string };

/**
 * Plan the sleep_quality → sleep merge for one log's events.
 *
 * `events` is the mixed set of `sleep` and `sleep_quality` rows; anything
 * else is ignored. Quality events are the work queue: each one produces
 * exactly one action. Deterministic: days ascending, qualities by timestamp
 * within a day; the attach target is the longest-duration sleep (ties:
 * earliest timestamp, then id).
 */
export function planSleepMerge(events: EventRow[], tz: string): SleepMergeAction[] {
  const byDay = new Map<string, { sleeps: EventRow[]; qualities: EventRow[] }>();
  for (const ev of events) {
    if (ev.subject_id !== "sleep" && ev.subject_id !== "sleep_quality") continue;
    const day = localDayKey(ev.timestamp, tz);
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = { sleeps: [], qualities: [] };
      byDay.set(day, bucket);
    }
    (ev.subject_id === "sleep" ? bucket.sleeps : bucket.qualities).push(ev);
  }

  const actions: SleepMergeAction[] = [];
  const byTsThenId = (a: EventRow, b: EventRow) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id < b.id ? -1 : 1;

  for (const day of [...byDay.keys()].sort()) {
    const { sleeps, qualities } = byDay.get(day)!;
    if (qualities.length === 0) continue;

    // Longest-duration sleep first; ties broken by timestamp, then id.
    const ranked = [...sleeps].sort((a, b) => {
      const d = sleepDurationMinutes(b) - sleepDurationMinutes(a);
      return d !== 0 ? d : byTsThenId(a, b);
    });
    let target: EventRow | undefined = ranked[0];
    // Track the target's state across multiple qualities on the same day
    // (the second quality must see the first one's planned attach). Only an
    // entry literally named "rating" counts as a pre-existing rating — a
    // lone numeric `duration` must not read as one.
    const namedRatingEntry = (entries: Entry[]): Entry | undefined =>
      entries.find((en) => en.name === "rating" && en.type === "number");
    let targetEntries: Entry[] = target ? [...target.entries] : [];
    let targetLabels: Labels | null = target?.labels ?? null;
    let targetEndTime: string | undefined = target?.end_time;
    /** Set when this day's target is a planned `create` (no PATCH possible). */
    let targetIsPlanned = false;

    for (const q of [...qualities].sort(byTsThenId)) {
      const extracted = extractRating(q);
      if (extracted.kind === "none") {
        actions.push({ kind: "skip", day, qualityId: q.id, reason: extracted.reason });
        continue;
      }
      if (extracted.kind === "not-rating") {
        actions.push({ kind: "conflict", day, qualityId: q.id, sleepId: target?.id, reason: extracted.reason });
        continue;
      }
      const { rating, extras } = extracted;
      const qLabels = q.labels && Object.keys(q.labels).length > 0 ? q.labels : null;

      if (!target) {
        // No sleep event that day: create one at the quality's timestamp,
        // carrying its rating (verbatim unit/scale), extras, labels and
        // end_time so deleting the quality event loses nothing.
        const entries: Entry[] = [ratingEntry(rating), ...extras];
        actions.push({
          kind: "create",
          day,
          qualityId: q.id,
          rating: rating.value,
          event: {
            subject_id: "sleep",
            timestamp: q.timestamp,
            end_time: q.end_time,
            entries,
            labels: qLabels ? { ...qLabels } : null,
            created_by: q.created_by,
          },
        });
        // The created sleep becomes the day's target: a second quality on
        // the same day must conflict, not create a duplicate sleep.
        target = { id: `(planned create for ${q.id})`, subject_id: "sleep", timestamp: q.timestamp, entries, labels: null };
        targetEntries = entries;
        targetLabels = qLabels ? { ...qLabels } : null;
        targetEndTime = q.end_time;
        targetIsPlanned = true;
        continue;
      }

      const targetRating = namedRatingEntry(targetEntries);
      if (targetRating !== undefined) {
        // The target already carries a rating. Only when EVERYTHING on the
        // quality event is already present deep-equal on the target (the
        // crash-between-PATCH-and-DELETE rerun shape) is delete-only safe;
        // anything else is a conflict for the operator.
        const healed =
          !targetIsPlanned &&
          sameRating(targetRating, rating) &&
          extras.every((e) => targetEntries.some((t) => entryEqual(t, e))) &&
          labelsAlreadyOn(targetLabels, qLabels) &&
          (q.end_time === undefined || q.end_time === targetEndTime);
        if (healed) {
          actions.push({ kind: "delete-only", day, qualityId: q.id, sleepId: target.id, rating: rating.value });
        } else {
          const tr = targetRating.type === "number" ? targetRating : undefined;
          const reason = targetIsPlanned
            ? `a sleep create is already planned for this day (rating ${tr?.value}); second quality (rating ${rating.value}) left untouched`
            : sameRating(targetRating, rating)
              ? "rating matches but the quality event carries entries/labels/end_time not on the target"
              : `target sleep already has rating=${tr?.value}/${tr?.scale ?? 5} (incoming ${rating.value}/${rating.scale ?? 5})`;
          actions.push({ kind: "conflict", day, qualityId: q.id, sleepId: target.id, reason });
        }
        continue;
      }

      // Carried extras must not clobber same-named entries on the sleep event.
      const clash = extras.find((e) => targetEntries.some((t) => t.name === e.name));
      if (clash) {
        actions.push({
          kind: "conflict",
          day,
          qualityId: q.id,
          sleepId: target.id,
          reason: `quality entry "${clash.name}" collides with an existing sleep entry`,
        });
        continue;
      }

      // Labels merge: same-key-different-value is a conflict, never a clobber.
      const labelMerge = mergeLabels(targetLabels, qLabels);
      if (labelMerge.clashKey) {
        actions.push({
          kind: "conflict",
          day,
          qualityId: q.id,
          sleepId: target.id,
          reason: `quality label "${labelMerge.clashKey}" collides with a differing value on the sleep event`,
        });
        continue;
      }

      // end_time: carry when the target has none; differing values conflict.
      if (q.end_time !== undefined && targetEndTime !== undefined && q.end_time !== targetEndTime) {
        actions.push({
          kind: "conflict",
          day,
          qualityId: q.id,
          sleepId: target.id,
          reason: `quality end_time ${q.end_time} differs from sleep end_time ${targetEndTime}`,
        });
        continue;
      }
      const newEndTime = q.end_time !== undefined && targetEndTime === undefined ? q.end_time : undefined;

      const newEntries: Entry[] = [...targetEntries, ratingEntry(rating), ...extras];
      actions.push({
        kind: "attach",
        day,
        qualityId: q.id,
        sleepId: target.id,
        rating: rating.value,
        newEntries,
        ...(labelMerge.changed && labelMerge.merged ? { newLabels: labelMerge.merged } : {}),
        ...(newEndTime !== undefined ? { newEndTime } : {}),
        carried: extras.map((e) => e.name),
      });
      targetEntries = newEntries;
      targetLabels = labelMerge.merged;
      if (newEndTime !== undefined) targetEndTime = newEndTime;
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Script 2: split category-shaped subjects
// ---------------------------------------------------------------------------

/** Subjects whose events get split into per-thing subjects. */
export const CATEGORY_SUBJECTS = ["exercise", "focus"] as const;

/**
 * Clean slug: lowercase, [a-z0-9-] only, non-alphanumeric runs become a
 * single dash, leading/trailing dashes trimmed.
 * "PT" → "pt", "trip planning" → "trip-planning", "Run & Lift" → "run-lift".
 */
export function slugifyCategory(category: string): string {
  return category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type CategorySplitAction =
  | {
      kind: "rewrite";
      id: string;
      oldSubjectId: string;
      newSubjectId: string;
      entries: Entry[];
      labels: Record<string, string> | null;
      /** True when an `intensity` entry was renamed to `rating`. */
      renamedIntensity: boolean;
    }
  | { kind: "missing-category"; id: string; subjectId: string }
  /** Post-rewrite shape of a self-named category (e.g. category "Exercise"
   *  on subject "exercise"): no category label, intensity already renamed
   *  to rating. Benign — a prior run converted it; nothing left to do. */
  | { kind: "already-converted"; id: string; subjectId: string }
  | { kind: "conflict"; id: string; subjectId: string; reason: string };

/** Plan the rewrite for a single exercise/focus event. Pure + per-event. */
export function planCategorySplit(ev: EventRow): CategorySplitAction {
  const labels = ev.labels ?? {};
  const category = labels.category;
  const slug = typeof category === "string" ? slugifyCategory(category) : "";
  if (!slug) {
    // A category that slugified to the event's own subject ("Exercise" on
    // `exercise`) leaves a rewritten event still matching the candidate
    // filter. Positive evidence only: a `rating` entry with no `intensity`
    // is the rename's signature — old-schema events carried `intensity`.
    const hasRating = ev.entries.some((e) => e.name === "rating");
    const hasIntensity = ev.entries.some((e) => e.name === "intensity");
    if (hasRating && !hasIntensity) {
      return { kind: "already-converted", id: ev.id, subjectId: ev.subject_id };
    }
    return { kind: "missing-category", id: ev.id, subjectId: ev.subject_id };
  }

  const hasIntensity = ev.entries.some((e) => e.name === "intensity" && e.type === "number");
  if (hasIntensity && ev.entries.some((e) => e.name === "rating")) {
    return {
      kind: "conflict",
      id: ev.id,
      subjectId: ev.subject_id,
      reason: "event has both intensity and rating entries; renaming would duplicate names",
    };
  }
  const entries: Entry[] = ev.entries.map((e) =>
    e.name === "intensity" && e.type === "number" ? { ...e, name: "rating" } : e,
  );

  const newLabels: Record<string, string> = { ...labels };
  delete newLabels.category;

  return {
    kind: "rewrite",
    id: ev.id,
    oldSubjectId: ev.subject_id,
    newSubjectId: slug,
    entries,
    labels: Object.keys(newLabels).length > 0 ? newLabels : null,
    renamedIntensity: hasIntensity,
  };
}

// ---------------------------------------------------------------------------
// Script 3: fan fat *_session events out into per-item events
// ---------------------------------------------------------------------------

// The session subject list, view map, legacy-name->vocab-id map, and rated-id
// set are the SINGLE shared source of truth in `@homelab/backend`
// (life-session-runs.ts). The cutover READ path (frontend readers + the Coach
// bundle) normalizes against the SAME map, so the write path, this migration,
// and every reader can never diverge on how a prompt maps to a vocab id.
//
// The planner HARD-FAILS on any entry name not present in SESSION_ID_MAP for its
// subject (an `error` action, never a silent drop) — the guard against drift
// between the audit and the run. Re-exported so the driver + tests keep their
// existing `./lib/life-rewrite` import sites unchanged.
export {
  SESSION_SUBJECTS,
  SESSION_VIEW,
  SESSION_ID_MAP,
  RATED_NEW_IDS,
} from "@homelab/backend";
export type { SessionSubject } from "@homelab/backend";
import {
  SESSION_SUBJECTS,
  SESSION_VIEW,
  SESSION_ID_MAP,
  RATED_NEW_IDS,
  type SessionSubject,
} from "@homelab/backend";

/** A single fanned-out child event to create. */
export interface FanoutChild {
  subjectId: string;
  entries: [Entry];
  labels: { source: string; view: string; view_run: string };
  timestamp: string;
  created_by?: string;
}

export type SessionFanoutAction =
  /** CREATE one per-item child for a session entry whose child does not yet
   *  exist (keyed on `(subjectId, view_run)`). */
  | { kind: "create"; sourceId: string; subject: SessionSubject; entryName: string; child: FanoutChild }
  /** The child for this entry already exists (a prior partial run) — skip it,
   *  create nothing. */
  | { kind: "skip"; sourceId: string; subject: SessionSubject; entryName: string; subjectId: string; reason: string }
  /** DELETE the source: the full expected child set is present (either created
   *  this run or pre-existing). Ordered LAST per source. */
  | { kind: "delete-source"; sourceId: string; subject: SessionSubject }
  /** Every child already existed (fully-migrated source from a prior run):
   *  nothing to create, just delete the source. A flavour of delete-source
   *  reported distinctly so reruns read as no-op-ish. */
  | { kind: "delete-only"; sourceId: string; subject: SessionSubject }
  /** An entry name with NO disposition in SESSION_ID_MAP. The driver must NOT
   *  apply (no create, and crucially no delete-source for this source) and
   *  exit non-zero. Nothing is ever dropped silently. */
  | { kind: "error"; sourceId: string; subject: SessionSubject; entryName: string; reason: string };

/** Normalize a legacy fat-session entry into the canonical per-item entry for
 *  its new subject id. RATED ids get `{name:"rating", unit:"rating", scale}`;
 *  everything else is `{name:"note", type:"text"}`. */
function normalizeEntry(newSubjectId: string, src: Entry): Entry {
  if (RATED_NEW_IDS.has(newSubjectId)) {
    // Carry the source's numeric value + scale; canonicalize name + unit.
    const value = src.type === "number" ? src.value : Number(src.value);
    const scale = src.type === "number" ? src.scale ?? 5 : 5;
    return { name: "rating", type: "number", value, unit: "rating", scale };
  }
  // noted: a single text note. Source value coerced to string.
  const value = src.type === "text" ? src.value : String(src.value);
  return { name: "note", type: "text", value };
}

/**
 * Plan the session→per-item fanout for one log's events.
 *
 * `events` is the mixed set of fat `*_session` SOURCE rows AND any prior-run
 * CHILD rows (events carrying `labels.view_run`). Real `mood` sampling events
 * have NO `view_run`, so they are never mistaken for children — children are
 * matched by `(subject_id, labels.view_run === source.timestamp)`.
 *
 * Per source, deterministically (sources by timestamp then id; entries in
 * stored order):
 *   - one `create` per entry whose child is MISSING (mapped id),
 *   - one `skip` per entry whose child already exists,
 *   - then exactly one `delete-source` (all expected children present after
 *     this run's creates) or `delete-only` (all pre-existed) — ordered LAST,
 *   - UNLESS any entry is unmapped: each such entry yields an `error` and the
 *     source gets NO delete action (nothing dropped with an unmapped entry).
 *
 * Idempotency is PER CHILD: a partial/crashed run that created some children
 * creates only the missing ones, then deletes the source.
 */
export function planSessionFanout(events: EventRow[]): SessionFanoutAction[] {
  // Index prior-run children by (subject_id, view_run). Only events carrying a
  // labels.view_run are children — a live `mood` sample has none, so it can't
  // block creating a migrated mood child.
  const childKeys = new Set<string>();
  for (const ev of events) {
    const viewRun = ev.labels?.view_run;
    if (viewRun) childKeys.add(`${ev.subject_id} ${viewRun}`);
  }

  const sources = events
    .filter((ev): ev is EventRow & { subject_id: SessionSubject } =>
      (SESSION_SUBJECTS as readonly string[]).includes(ev.subject_id),
    )
    .sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id < b.id ? -1 : 1,
    );

  // Detect duplicate (subject_id, timestamp) AMONG THE SOURCES themselves — two
  // distinct fat-session rows sharing the same (subject_id, timestamp), i.e. a
  // genuine double-submit. The child idempotency key is (newSubjectId,
  // view_run=src.timestamp), so two such sources would BOTH reserve the same
  // child keys: the first creates every child; the second sees them all present
  // and would emit `delete-only`, silently deleting itself and losing its
  // entries forever. Refuse the whole colliding cohort: each gets one `error`
  // action and NO delete, so the driver leaves them intact and exits non-zero
  // for the operator to investigate. This is INDEPENDENT of `childKeys` (which
  // tracks legitimate PRIOR-RUN children) — a real prior-run child rightly
  // shares the key, but two live sources must never.
  const sourceTsCounts = new Map<string, number>();
  for (const src of sources) {
    const k = `${src.subject_id} ${src.timestamp}`;
    sourceTsCounts.set(k, (sourceTsCounts.get(k) ?? 0) + 1);
  }

  const actions: SessionFanoutAction[] = [];
  for (const src of sources) {
    const subject = src.subject_id;
    const view = SESSION_VIEW[subject];
    const viewRun = src.timestamp; // children correlate on the source timestamp
    const map = SESSION_ID_MAP[subject];
    const source = (src.labels?.source as string) ?? "manual";

    // Duplicate-source guard: this source shares its (subject_id, timestamp)
    // with another live source. Emit one error, create nothing, delete nothing.
    if ((sourceTsCounts.get(`${subject} ${viewRun}`) ?? 0) > 1) {
      actions.push({
        kind: "error",
        sourceId: src.id,
        subject,
        entryName: "*",
        reason: `source ${src.id} (${subject}) shares (subject_id, timestamp=${viewRun}) with another source — a double-submit whose fanout would collide and drop one source's entries; refusing both`,
      });
      continue;
    }

    let hadError = false;
    let createdCount = 0;
    const sourceActions: SessionFanoutAction[] = [];
    // Two entries within ONE source mapping to the same new id would collide on
    // `key`; the reserve-after-check below would DEDUPE them to a single child
    // (the second sees the key the first reserved -> `skip`), silently dropping
    // the second entry. No current session view maps two entry names to the
    // same new subject_id, so this can't fire today — but assert it here so a
    // future SESSION_ID_MAP edit that introduces such a shape fails loud instead
    // of losing data.
    const reservedThisSource = new Set<string>();

    for (const entry of src.entries) {
      const newSubjectId = map[entry.name];
      if (newSubjectId === undefined) {
        hadError = true;
        sourceActions.push({
          kind: "error",
          sourceId: src.id,
          subject,
          entryName: entry.name,
          reason: `entry "${entry.name}" on ${subject} has no disposition in SESSION_ID_MAP`,
        });
        continue;
      }
      const key = `${newSubjectId} ${viewRun}`;
      // Two entries in THIS source mapping to the same new id collide on `key`.
      // Fail loud instead of silently deduping (see reservedThisSource above).
      if (reservedThisSource.has(key)) {
        hadError = true;
        sourceActions.push({
          kind: "error",
          sourceId: src.id,
          subject,
          entryName: entry.name,
          reason: `entry "${entry.name}" on ${subject} maps to ${newSubjectId}, which another entry in the SAME source already maps to; SESSION_ID_MAP must be 1:1 per source or fanout would dedupe and drop one`,
        });
        continue;
      }
      // Rated child whose normalized value is non-finite (text/garbage on a
      // numeric rated id) would write NaN as the rating. Fail loud, exactly like
      // an unmapped name: error, no create, source survives, run exits non-zero.
      if (RATED_NEW_IDS.has(newSubjectId)) {
        const num = entry.type === "number" ? entry.value : Number(entry.value);
        if (!Number.isFinite(num)) {
          hadError = true;
          sourceActions.push({
            kind: "error",
            sourceId: src.id,
            subject,
            entryName: entry.name,
            reason: `rated entry "${entry.name}" on ${subject} to ${newSubjectId} has a non-numeric value (${JSON.stringify(
              entry.value,
            )}) that coerces to NaN; refusing to write NaN as a rating`,
          });
          continue;
        }
      }
      if (childKeys.has(key)) {
        sourceActions.push({
          kind: "skip",
          sourceId: src.id,
          subject,
          entryName: entry.name,
          subjectId: newSubjectId,
          reason: `child ${newSubjectId} for view_run ${viewRun} already exists`,
        });
        continue;
      }
      // Reserve this child key (both the shared cross-run index and the
      // per-source dedupe set) so a partial-run collision creates exactly once.
      childKeys.add(key);
      reservedThisSource.add(key);
      createdCount++;
      sourceActions.push({
        kind: "create",
        sourceId: src.id,
        subject,
        entryName: entry.name,
        child: {
          subjectId: newSubjectId,
          entries: [normalizeEntry(newSubjectId, entry)],
          labels: { source, view, view_run: viewRun },
          timestamp: src.timestamp,
          ...(src.created_by ? { created_by: src.created_by } : {}),
        },
      });
    }

    actions.push(...sourceActions);

    if (hadError) {
      // Leave the source intact: an unmapped entry must never be lost to a
      // delete. No delete action is emitted for this source.
      continue;
    }
    // Full expected child set is present (created this run + any pre-existing).
    if (createdCount === 0) {
      actions.push({ kind: "delete-only", sourceId: src.id, subject });
    } else {
      actions.push({ kind: "delete-source", sourceId: src.id, subject });
    }
  }
  return actions;
}
