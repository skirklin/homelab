/**
 * One-pass, tz-aware day index over `life_events`.
 *
 * The calendar view renders many cells (≈20 trackables × ≈42 days), and each
 * cell needs to know "did this subject happen on this local day / how much / which
 * events?". Scanning every event per cell is O(events × cells) — instead we build
 * a single index in ONE O(events) pass and read from it in O(1) per cell.
 *
 * CRITICAL: every day bucket is keyed by the user's tz via the SAME helpers the
 * goal evaluator uses (`dayKey` from `@homelab/backend`). This is what makes a
 * calendar cell agree with goal math: a 6pm-Pacific event (next-day UTC) lands on
 * the Pacific day, not the UTC day. No runtime `setHours` bucketing anywhere here.
 */
import type { LifeEvent } from "@homelab/backend";
import { dayKey } from "@homelab/backend";

/** Per (subject, day) aggregate. */
export interface DayCell {
  /** How many events for this subject fell on this local day. */
  count: number;
  /**
   * Sum of every non-rating number entry, keyed by unit. Mirrors the evaluator's
   * name-agnostic `sum` metric (it sums entries whose `unit` matches the goal's),
   * so a cap goal's daily-sum coloring matches the goal's own arithmetic.
   */
  sums: Map<string, number>;
  /** The events themselves (insertion order = chronological as fed in). */
  events: LifeEvent[];
}

/** subjectId → (dayKey → DayCell). */
export type DayIndex = Map<string, Map<string, DayCell>>;

/**
 * Build the index in one pass. `tz` is the user's IANA zone — the SAME zone the
 * goal evaluator is threaded with — so day boundaries agree.
 */
export function buildDayIndex(events: LifeEvent[], tz: string): DayIndex {
  const index: DayIndex = new Map();
  for (const ev of events) {
    const key = dayKey(ev.timestamp, tz);
    let byDay = index.get(ev.subjectId);
    if (!byDay) {
      byDay = new Map();
      index.set(ev.subjectId, byDay);
    }
    let cell = byDay.get(key);
    if (!cell) {
      cell = { count: 0, sums: new Map(), events: [] };
      byDay.set(key, cell);
    }
    cell.count += 1;
    cell.events.push(ev);
    for (const entry of ev.entries) {
      if (entry.type === "number" && entry.unit !== "rating") {
        cell.sums.set(entry.unit, (cell.sums.get(entry.unit) ?? 0) + entry.value);
      }
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Query helpers — read-only, O(subjectIds) per cell, no event scans.
// ---------------------------------------------------------------------------

/** Did ANY of `subjectIds` have ≥1 event on `dayKeyStr`? */
export function dayHas(index: DayIndex, subjectIds: string[], dayKeyStr: string): boolean {
  for (const id of subjectIds) {
    const cell = index.get(id)?.get(dayKeyStr);
    if (cell && cell.count > 0) return true;
  }
  return false;
}

/** Total `unit`-summed value across `subjectIds` on `dayKeyStr` (0 if none). */
export function daySum(
  index: DayIndex,
  subjectIds: string[],
  dayKeyStr: string,
  unit: string,
): number {
  let total = 0;
  for (const id of subjectIds) {
    const cell = index.get(id)?.get(dayKeyStr);
    if (cell) total += cell.sums.get(unit) ?? 0;
  }
  return total;
}

/** All events across `subjectIds` on `dayKeyStr`, newest first. */
export function dayEvents(index: DayIndex, subjectIds: string[], dayKeyStr: string): LifeEvent[] {
  const out: LifeEvent[] = [];
  for (const id of subjectIds) {
    const cell = index.get(id)?.get(dayKeyStr);
    if (cell) out.push(...cell.events);
  }
  out.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return out;
}
