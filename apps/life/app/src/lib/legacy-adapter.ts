/**
 * Normalize legacy life_events shapes into the new value-based event shape.
 * Read-only — never mutates PB rows.
 *
 * The new shape (written by EventLogger) is:
 *   data: { value: number, category?, intensity?, notes?, end_time? }
 *
 * Old shapes:
 *  - combo sleep    {hours, quality, notes?}  → value = hours*60 (+ derive a
 *                                                separate sleep_quality event)
 *  - combo exercise {hours, intensity, ...}   → value = hours*60, intensity?
 *  - combo work     {hours, quality, ...}     → value = hours*60 (display only;
 *                                                "work" isn't in TRACKABLES)
 *  - combo symptoms {<rating fields>}         → fan out per field (display only)
 *  - counter / counter-group {count: 1}       → value = 1
 *  - __sample__ {mood, content, ...}          → fan out one event per question
 *
 * Unknown shapes pass through untouched so we never lose data; the renderers
 * skip events they can't interpret.
 */
import type { LogEntry } from "../types";
import { TRACKABLES } from "../manifest";

/** Trackables map — kept here to avoid pulling the whole manifest into renderers. */
const TRACKABLE_IDS = new Set(TRACKABLES.map((t) => t.id));

/** Trackable ids that are rating-shaped — the legacy sample modal wrote rows
 *  with subject_id="__sample__" and per-question keys (mood, content). */
const SAMPLE_QUESTION_IDS = new Set(["mood", "content", "energy", "sleep_quality"]);

export interface NormalizedEvent extends LogEntry {
  /** True if this was synthesized from a legacy row. */
  derived?: boolean;
}

/**
 * Normalize one entry. Returns 0+ normalized events:
 *  - 1 event for straight pass-through or shape-translated rows
 *  - 2+ events when fanning out (sleep → sleep + sleep_quality, sample → per
 *    question), or 0 if the row is a session/unknown shape we drop on read.
 */
export function normalizeEntry(entry: LogEntry): NormalizedEvent[] {
  const data = entry.data || {};

  // Already in new shape — has a numeric `value`. Pass through.
  if (typeof data.value === "number") {
    return [entry];
  }

  // Random-sample fan-out. Subject_id was "__sample__" with one key per question.
  if (entry.subjectId === "__sample__") {
    const out: NormalizedEvent[] = [];
    for (const [key, raw] of Object.entries(data)) {
      if (!SAMPLE_QUESTION_IDS.has(key)) continue;
      if (typeof raw !== "number") continue;
      out.push({
        ...entry,
        id: `${entry.id}:${key}`,
        subjectId: key,
        derived: true,
        data: { value: raw, source: "sample" },
      });
    }
    return out;
  }

  // Sleep combo: {hours, quality, notes?}. Emit sleep event + sleep_quality event.
  if (entry.subjectId === "sleep") {
    const out: NormalizedEvent[] = [];
    const hours = typeof data.hours === "number" ? data.hours : undefined;
    const quality = typeof data.quality === "number" ? data.quality : undefined;
    const notes = typeof data.notes === "string" ? data.notes : undefined;
    if (hours !== undefined) {
      out.push({
        ...entry,
        derived: true,
        data: { value: hours * 60, ...(notes ? { notes } : {}) },
      });
    }
    if (quality !== undefined) {
      out.push({
        ...entry,
        id: `${entry.id}:quality`,
        subjectId: "sleep_quality",
        derived: true,
        data: { value: quality },
      });
    }
    return out;
  }

  // Exercise combo: {hours, intensity, category?}.
  if (entry.subjectId === "exercise") {
    const hours = typeof data.hours === "number" ? data.hours : undefined;
    if (hours === undefined) return [];
    const intensity = typeof data.intensity === "number" ? data.intensity : undefined;
    const category = typeof data.category === "string" ? data.category : undefined;
    return [{
      ...entry,
      derived: true,
      data: {
        value: hours * 60,
        ...(intensity !== undefined ? { intensity } : {}),
        ...(category ? { category } : {}),
      },
    }];
  }

  // Counter / counter-group historical rows: {count: 1} (or just empty).
  // If the subject_id is a known trackable, default value to 1.
  if (TRACKABLE_IDS.has(entry.subjectId)) {
    const count = typeof data.count === "number" ? data.count : 1;
    return [{
      ...entry,
      derived: true,
      data: { value: count, ...passthroughExtras(data) },
    }];
  }

  // Legacy work / symptoms / anything else: pass through untouched. They
  // won't appear in dashboard widgets (no matching trackable) but the
  // Visualizations and Journal can still see them if they choose.
  return [entry];
}

function passthroughExtras(data: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  if (typeof data.notes === "string") extras.notes = data.notes;
  if (typeof data.source === "string") extras.source = data.source;
  return extras;
}

/** Flat-map normalizeEntry across a list. */
export function normalizeEntries(entries: LogEntry[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const e of entries) {
    for (const n of normalizeEntry(e)) {
      out.push(n);
    }
  }
  return out;
}

/** Get normalized entries for one trackable on a given date. */
export function getEntriesForTrackable(
  entries: LogEntry[],
  trackableId: string,
  targetDate?: Date,
): NormalizedEvent[] {
  const date = targetDate ?? new Date();
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const matching: NormalizedEvent[] = [];
  for (const e of entries) {
    if (e.timestamp < startOfDay || e.timestamp > endOfDay) continue;
    for (const n of normalizeEntry(e)) {
      if (n.subjectId === trackableId) matching.push(n);
    }
  }
  // Most recent first.
  matching.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return matching;
}
