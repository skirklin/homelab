/**
 * Display + aggregation helpers for the unified life event shape.
 *
 * Storage is canonical (durations in minutes, doses in mg, etc.); these
 * helpers translate one entry's value back into a human-friendly string,
 * and tell aggregators whether to sum or average a given unit.
 */
import type { LifeEntry, LifeEvent } from "@homelab/backend";

export type Aggregation = "sum" | "avg";

/**
 * How a unit aggregates across entries on a single day.
 *
 *   "rating" → average (a day's overall mood is the average of samples)
 *   everything else → sum (durations, doses, counts all sum)
 *
 * Future extension: if you add a unit that should aggregate as "last"
 * (e.g. weight in lb), special-case it here. Today there are none.
 */
export function aggregationFor(unit: string): Aggregation {
  return unit === "rating" ? "avg" : "sum";
}

/**
 * Round to one decimal place. Used by averages so "4.2" doesn't surface as
 * "4.199999999998".
 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Aggregate a list of numbers per the unit's policy. */
export function aggregate(values: number[], unit: string): number | null {
  if (values.length === 0) return null;
  if (aggregationFor(unit) === "avg") {
    return round1(values.reduce((a, b) => a + b, 0) / values.length);
  }
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Format a duration in minutes as "8h 30m", "45m", "2h", etc. Sub-zero or
 * NaN values render as a placeholder.
 */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "—";
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Format a rating value as "4/5". */
export function formatRating(value: number, scale: number = 5): string {
  return `${value}/${scale}`;
}

/**
 * Generic dose/volume/count formatter — value + unit string with a small
 * carveout for human-friendly rendering. Doesn't try to pluralize anything;
 * the unit shorthand reads fine either way ("1 mg", "2 mg").
 */
export function formatDose(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "—";
  // Coffee oz reads as "8 oz", drinks as "1 drinks" (rough; pluralize if we
  // ever care). Counts intentionally drop the unit — "1" alone reads better
  // than "1 ct".
  if (unit === "ct") return `${value}`;
  return `${value} ${unit}`;
}

/**
 * Format one entry for human display. Used in popovers / detail rows.
 * For text entries, returns the value verbatim.
 */
export function formatEntry(entry: LifeEntry): string {
  if (entry.type === "text") return entry.value;
  if (entry.type === "bool") return entry.value ? "Yes" : "No";
  switch (entry.unit) {
    case "min":
      return formatDuration(entry.value);
    case "rating":
      return formatRating(entry.value, entry.scale ?? 5);
    default:
      return formatDose(entry.value, entry.unit);
  }
}

/**
 * Find the numeric entry named `name` in an event, or undefined if absent /
 * not numeric. Convenience for renderers that pull a primary value out (e.g.
 * sleep "duration", exercise "duration").
 */
export function findNumberEntry(
  event: LifeEvent,
  name: string,
): { value: number; unit: string; scale?: number } | undefined {
  for (const e of event.entries) {
    if (e.type === "number" && e.name === name) {
      return { value: e.value, unit: e.unit, scale: e.scale };
    }
  }
  return undefined;
}

/** Find a text entry by name. */
export function findTextEntry(event: LifeEvent, name: string): string | undefined {
  for (const e of event.entries) {
    if (e.type === "text" && e.name === name) return e.value;
  }
  return undefined;
}

/**
 * Collect every numeric `value` for entries named `name` across a list of
 * events. Useful for per-trackable aggregation: walk the event list, pull
 * the primary entry, hand the list to `aggregate()`.
 */
export function collectNumberValues(events: LifeEvent[], name: string): number[] {
  const out: number[] = [];
  for (const ev of events) {
    for (const e of ev.entries) {
      if (e.type === "number" && e.name === name) out.push(e.value);
    }
  }
  return out;
}

/**
 * "Source" convenience — a stable extractor for the labels.source dimension.
 * Defaults to "manual" so callers get a non-empty string back without
 * branching.
 */
export function eventSource(ev: LifeEvent): string {
  return ev.labels?.source ?? "manual";
}

/**
 * Convention: what's the primary numeric entry name for a given trackable id?
 * The EventLogger writes one row per logged value and names that entry per
 * this table; dashboard aggregation reads the same names back out.
 *
 * Per-subject (over the unit) so the few cases that broke the "count"
 * default — alcohol stores "drinks", coffee stores "volume", medical doses
 * store "dose" — are named meaningfully on read.
 */
export function primaryEntryName(subjectId: string): string {
  switch (subjectId) {
    case "vyvanse":
    case "ibuprofin":
    case "edibles":
      return "dose";
    case "alcohol":
      return "drinks";
    case "coffee":
      return "volume";
    case "sleep":
    case "exercise":
    case "focus":
      return "duration";
    case "mood":
    case "content":
    case "sleep_quality":
      return "rating";
    default:
      return "count";
  }
}
