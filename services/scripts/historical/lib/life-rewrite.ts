/**
 * Pure transform logic for the 2026-06 life-tracker history rewrites:
 *
 *   1. merge-sleep-quality.ts — fold standalone `sleep_quality` events into
 *      the same local day's `sleep` event as a `rating` entry.
 *   2. split-category-subjects.ts — split category-shaped subjects
 *      (`exercise`, `focus`) into per-thing subjects derived from
 *      `labels.category`, renaming `intensity` → `rating`.
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

/** Pull the numeric rating out of a sleep_quality event: the entry named
 *  `rating`, else the single numeric entry if there is exactly one. */
export function extractRating(ev: EventRow): number | undefined {
  const named = ev.entries.find((e) => e.name === "rating" && e.type === "number");
  if (named && named.type === "number") return named.value;
  const numeric = ev.entries.filter((e) => e.type === "number");
  if (numeric.length === 1 && numeric[0].type === "number") return numeric[0].value;
  return undefined;
}

export type SleepMergeAction =
  /** PATCH the sleep event's entries, then DELETE the quality event. */
  | {
      kind: "attach";
      day: string;
      qualityId: string;
      sleepId: string;
      rating: number;
      newEntries: Entry[];
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
        entries: Entry[];
        labels: Record<string, string> | null;
        created_by?: string;
      };
    }
  /** Target sleep already carries the identical rating (e.g. a previous run
   *  died between PATCH and DELETE): just DELETE the quality event. */
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
    // Track the target's rating across multiple qualities on the same day
    // (the second quality must see the first one's planned attach). Only an
    // entry literally named "rating" counts — a lone numeric `duration`
    // must not read as a pre-existing rating.
    const namedRating = (e: EventRow): number | undefined => {
      const r = e.entries.find((en) => en.name === "rating" && en.type === "number");
      return r && r.type === "number" ? r.value : undefined;
    };
    let targetRating: number | undefined = target ? namedRating(target) : undefined;
    let targetEntries: Entry[] = target ? [...target.entries] : [];
    /** Set when this day's target is a planned `create` (no PATCH possible). */
    let targetIsPlanned = false;

    for (const q of [...qualities].sort(byTsThenId)) {
      const rating = extractRating(q);
      if (rating === undefined) {
        actions.push({ kind: "skip", day, qualityId: q.id, reason: "no numeric rating entry on sleep_quality event" });
        continue;
      }
      // Non-rating entries on the quality event (e.g. notes) ride along so
      // deleting the event loses nothing.
      const extras = q.entries.filter((e) => !(e.name === "rating" && e.type === "number"));

      if (!target) {
        // No sleep event that day: create one at the quality's timestamp.
        const entries: Entry[] = [
          { name: "rating", type: "number", value: rating, unit: "rating", scale: 5 },
          ...extras,
        ];
        actions.push({
          kind: "create",
          day,
          qualityId: q.id,
          rating,
          event: {
            subject_id: "sleep",
            timestamp: q.timestamp,
            entries,
            labels: q.labels && Object.keys(q.labels).length > 0 ? { ...q.labels } : null,
            created_by: q.created_by,
          },
        });
        // The created sleep becomes the day's target: a second quality on
        // the same day must conflict, not create a duplicate sleep.
        target = { id: `(planned create for ${q.id})`, subject_id: "sleep", timestamp: q.timestamp, entries, labels: null };
        targetRating = rating;
        targetEntries = entries;
        targetIsPlanned = true;
        continue;
      }

      if (targetRating !== undefined) {
        if (targetRating === rating && !targetIsPlanned && extras.length === 0) {
          // Identical rating already on the target (interrupted prior run):
          // safe to just drop the quality event.
          actions.push({ kind: "delete-only", day, qualityId: q.id, sleepId: target.id, rating });
        } else {
          actions.push({
            kind: "conflict",
            day,
            qualityId: q.id,
            sleepId: target.id,
            reason: `target sleep already has rating=${targetRating} (incoming ${rating})`,
          });
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

      const newEntries: Entry[] = [
        ...targetEntries,
        { name: "rating", type: "number", value: rating, unit: "rating", scale: 5 },
        ...extras,
      ];
      actions.push({
        kind: "attach",
        day,
        qualityId: q.id,
        sleepId: target.id,
        rating,
        newEntries,
        carried: extras.map((e) => e.name),
      });
      targetRating = rating;
      targetEntries = newEntries;
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Script 2: split category-shaped subjects
// ---------------------------------------------------------------------------

/** Subjects whose events get split into per-thing subjects. */
export const CATEGORY_SUBJECTS = ["exercise", "focus"] as const;

/** "PT" → "pt", "trip planning" → "trip-planning", " Trail  Running " → "trail-running". */
export function slugifyCategory(category: string): string {
  return category.trim().toLowerCase().replace(/\s+/g, "-");
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
  | { kind: "conflict"; id: string; subjectId: string; reason: string };

/** Plan the rewrite for a single exercise/focus event. Pure + per-event. */
export function planCategorySplit(ev: EventRow): CategorySplitAction {
  const labels = ev.labels ?? {};
  const category = labels.category;
  const slug = typeof category === "string" ? slugifyCategory(category) : "";
  if (!slug) {
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
