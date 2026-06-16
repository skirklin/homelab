/**
 * Insights analysis lib — the pure, tz-correct heart of the charts surface.
 *
 * Every function reads from the already-memoized `DayIndex` (see lib/dayIndex)
 * — a ONE-pass O(events) bucketing of `life_events` into the user's local days.
 * Nothing here re-scans the raw event stream: series, percentiles, correlation,
 * and period deltas are all O(days), which is what keeps the views cheap on a
 * multi-year log. Day/week/month boundaries are computed with the SAME
 * `@homelab/backend` tz helpers the goal evaluator and day index use, so a
 * 23:00-local event lands in the right local day (and therefore the right local
 * week/month) — never the UTC one.
 *
 * The shape model decides what "a day's value" means, and the readers stay
 * name-agnostic (history predates the shape model — entry names dose/volume/
 * intensity, etc.), so `dailyValue` keys on unit, never on entry name.
 */
import type { DayIndex, DayCell } from "./dayIndex";
import type { LifeManifestTrackable, TrackableShape } from "@homelab/backend";
import { startOfWeek, dayKey, startOfDay, endOfDay } from "@homelab/backend";
import { aggregateEvents } from "./shapes";
import { monthKey, firstOfMonth } from "./habitStats";

// ---------------------------------------------------------------------------
// dailyValue — the canonical per-day scalar
// ---------------------------------------------------------------------------

/**
 * The magnitude unit a shape's daily value sums over. `did` always measures
 * minutes (duration); `took` uses the trackable's `defaultUnit`. `happened`
 * and `rated` don't sum a magnitude (count / mean-rating instead). Falling
 * back to "ct" keeps a defaultless `took` row chartable rather than blank.
 */
function magnitudeUnit(t: Pick<LifeManifestTrackable, "shape" | "defaultUnit">): string {
  return t.shape === "did" ? "min" : t.defaultUnit || "ct";
}

/**
 * The canonical scalar for a trackable on one day, or `null` when nothing was
 * logged. The shape decides the reduction:
 *   took / did → sum of the magnitude unit's values (minutes for did, the
 *                trackable's defaultUnit for took)
 *   rated      → mean rating that day (averaged, name-agnostically, over every
 *                rating-unit entry)
 *   happened   → event count
 *
 * The magnitude branches read the precomputed `cell.sums` (no event scan); a
 * magnitude row that happens to carry NO value of its declared unit on a day
 * (legacy data) falls back to the day's first-seen summed unit so the series
 * isn't silently empty. `rated` reads the cell's own events to average — that's
 * the bucket's events only, still O(events-on-that-day), not a global scan.
 */
export function dailyValue(
  trackable: Pick<LifeManifestTrackable, "shape" | "defaultUnit">,
  cell: DayCell | undefined,
): number | null {
  if (!cell || cell.count === 0) return null;
  switch (trackable.shape) {
    case "happened":
      return cell.count;
    case "rated": {
      const agg = aggregateEvents(cell.events);
      return agg.ratingAvg;
    }
    case "took":
    case "did": {
      const unit = magnitudeUnit(trackable);
      const v = cell.sums.get(unit);
      if (v !== undefined) return v;
      // Declared unit absent on this day — fall back to the first-seen summed
      // unit so legacy rows still chart instead of reading as empty.
      const first = cell.sums.entries().next();
      return first.done ? null : first.value[1];
    }
  }
}

/** How a trackable's daily values aggregate up to week/month buckets. */
export function trackableAggregation(shape: TrackableShape): "sum" | "avg" {
  // Ratings average; counts and magnitudes sum. (A week's "rating" is the mean
  // of its days, not the sum; a week's "minutes run" is the total.)
  return shape === "rated" ? "avg" : "sum";
}

// ---------------------------------------------------------------------------
// series — tz-correct day/week/month buckets sourced from the index
// ---------------------------------------------------------------------------

export type Granularity = "day" | "week" | "month";

export interface SeriesPoint {
  /** Bucket key: "YYYY-MM-DD" (day/week-start) or "YYYY-MM" (month). */
  date: string;
  value: number;
}

/** The bucket key for a local day, at the requested granularity. */
function bucketKey(day: Date, granularity: Granularity, tz: string): string {
  if (granularity === "day") return dayKey(day, tz);
  if (granularity === "month") return monthKey(day, tz);
  return dayKey(startOfWeek(day, tz), tz);
}

/**
 * A tz-correct series of `{date, value}` for one or more subjects, bucketed at
 * the requested granularity over `[from, to]` (inclusive local days). Daily
 * values are read from the index, then aggregated into week/month buckets per
 * the shape (sum for magnitude/count, mean for ratings).
 *
 * Buckets with no data are OMITTED, not zero-filled — a charting caller decides
 * whether to render gaps or a continuous axis. Multiple subjectIds (a group
 * rollup) combine by summing magnitudes/counts and averaging ratings across the
 * group on each day before bucketing.
 */
export function series(
  index: DayIndex,
  trackable: Pick<LifeManifestTrackable, "shape" | "defaultUnit">,
  subjectIds: string[],
  granularity: Granularity,
  from: Date,
  to: Date,
  tz: string,
): SeriesPoint[] {
  const agg = trackableAggregation(trackable.shape);
  // Accumulate per bucket: running sum + count so we can finish as mean or sum.
  const buckets = new Map<string, { sum: number; n: number }>();
  // Insertion order = chronological, because we walk days forward.
  const order: string[] = [];

  // Walk local days from `from` to `to`. Day stepping is via the tz-correct
  // day boundary so a DST day doesn't drift the cursor.
  let cursor = startOfDay(from, tz);
  const lastDay = startOfDay(to, tz);
  // Guard against pathological ranges (cursor must advance); 5y cap is plenty.
  for (let guard = 0; cursor <= lastDay && guard < 366 * 5; guard++) {
    const dk = dayKey(cursor, tz);
    const dv = dailyValueForDay(index, trackable, subjectIds, dk);
    if (dv !== null) {
      const key = bucketKey(cursor, granularity, tz);
      let b = buckets.get(key);
      if (!b) {
        b = { sum: 0, n: 0 };
        buckets.set(key, b);
        order.push(key);
      }
      b.sum += dv;
      b.n += 1;
    }
    // Advance one local day. endOfDay(cursor)+1ms re-normalizes through the tz
    // helper so the cursor never lands mid-day after a DST shift.
    cursor = new Date(endOfDay(cursor, tz).getTime() + 1);
  }

  return order.map((key) => {
    const b = buckets.get(key)!;
    const value = agg === "avg" ? Math.round((b.sum / b.n) * 10) / 10 : b.sum;
    return { date: key, value };
  });
}

/**
 * One day's combined value across `subjectIds` (a group rollup). Magnitude and
 * count shapes sum across the group; ratings average across the group's events
 * that day. Returns null when no subject logged that day.
 */
function dailyValueForDay(
  index: DayIndex,
  trackable: Pick<LifeManifestTrackable, "shape" | "defaultUnit">,
  subjectIds: string[],
  dk: string,
): number | null {
  if (subjectIds.length === 1) {
    return dailyValue(trackable, index.get(subjectIds[0])?.get(dk));
  }
  if (trackable.shape === "rated") {
    // Average across every rating-bearing event in the group that day.
    let total = 0;
    let n = 0;
    for (const id of subjectIds) {
      const cell = index.get(id)?.get(dk);
      if (!cell) continue;
      const agg = aggregateEvents(cell.events);
      if (agg.ratingAvg !== null) {
        total += agg.ratingAvg * agg.ratingCount;
        n += agg.ratingCount;
      }
    }
    return n > 0 ? Math.round((total / n) * 10) / 10 : null;
  }
  let total = 0;
  let any = false;
  for (const id of subjectIds) {
    const v = dailyValue(trackable, index.get(id)?.get(dk));
    if (v !== null) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * The local [from, to] day range a bucket key spans, for drill-down. A day key
 * is a single day; a week-start key spans 7 days; a month key spans its month.
 * Anchored at noon-local to dodge DST edges before the tz helpers re-normalize.
 */
export function bucketRange(key: string, granularity: Granularity, tz: string): { from: Date; to: Date } {
  if (granularity === "month") {
    // Anchor at noon-local-ish (UTC noon of the 1st), then snap via the tz
    // helpers so DST never drifts the boundary.
    const anchor = new Date(`${key}-01T12:00:00.000Z`);
    const from = firstOfMonth(anchor, tz);
    // Last instant of the month = one ms before the next month's 1st.
    const nextMonthAnchor = new Date(endOfDay(from, tz).getTime() + 32 * 24 * 60 * 60 * 1000);
    const to = new Date(firstOfMonth(nextMonthAnchor, tz).getTime() - 1);
    return { from, to };
  }
  const from = startOfDay(new Date(`${key}T12:00:00.000Z`), tz);
  if (granularity === "day") return { from, to: from };
  // Week: the key is the Sunday start; the range is the following 6 days.
  const to = new Date(endOfDay(from, tz).getTime() + 6 * 24 * 60 * 60 * 1000);
  return { from, to };
}

// ---------------------------------------------------------------------------
// percentileScale — magnitude shading
// ---------------------------------------------------------------------------

/**
 * Maps a value to its percentile rank (0..1) within `values` — the trackable's
 * own distribution — for shading a cell by "how big for this thing" rather than
 * raw magnitude (10 oz of water and 10 mg of a drug shouldn't shade alike).
 *
 * Rank is the fraction of samples ≤ v (ties share the higher rank), so the max
 * maps to 1 and a lone value maps to 1. Empty distribution → a flat 0 scale.
 */
export function percentileScale(values: number[]): (v: number) => number {
  if (values.length === 0) return () => 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (v: number) => {
    // Count of samples ≤ v via upper-bound binary search.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo / n;
  };
}

// ---------------------------------------------------------------------------
// correlate — Pearson r over the inner join of two daily series
// ---------------------------------------------------------------------------

export interface CorrelationPoint {
  x: number;
  y: number;
  date: string;
}

export interface Correlation {
  /** Pearson r in [-1, 1], or null when n < 3 (too few to be meaningful). */
  r: number | null;
  /** Number of days BOTH series have a value (the inner-join size). */
  n: number;
  points: CorrelationPoint[];
}

/**
 * Pearson correlation over the days BOTH series carry a value (inner join on
 * the bucket key). Returns the joined points for a scatter plot, the join size
 * `n`, and `r` — `null` when n < 3 (statistically meaningless) or when either
 * side has zero variance (a flat series can't correlate; r is undefined).
 */
export function correlate(a: SeriesPoint[], b: SeriesPoint[]): Correlation {
  const bByDate = new Map(b.map((p) => [p.date, p.value]));
  const points: CorrelationPoint[] = [];
  for (const p of a) {
    const y = bByDate.get(p.date);
    if (y !== undefined) points.push({ x: p.value, y, date: p.date });
  }
  const n = points.length;
  if (n < 3) return { r: null, n, points };

  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return { r: null, n, points };
  const r = cov / Math.sqrt(varX * varY);
  // Clamp to kill floating-point drift past ±1 (e.g. a perfect line → 1.0000002).
  return { r: Math.max(-1, Math.min(1, r)), n, points };
}

// ---------------------------------------------------------------------------
// periodCompare — current vs previous full period
// ---------------------------------------------------------------------------

export interface PeriodComparison {
  current: number;
  previous: number;
  deltaAbs: number;
  /** Percent change vs the previous period; null when previous is 0 (∞). */
  deltaPct: number | null;
}

/**
 * Compare a trackable's value in the current full period (week or month
 * containing `today`) against the previous one. The period value reduces the
 * same way week/month series buckets do (sum for magnitude/count, mean for
 * ratings), so this agrees with the Trends view's week/month bars.
 */
export function periodCompare(
  index: DayIndex,
  trackable: Pick<LifeManifestTrackable, "shape" | "defaultUnit">,
  subjectIds: string[],
  period: "week" | "month",
  tz: string,
  today: Date,
): PeriodComparison {
  const granularity: Granularity = period;
  const curStart = currentStart(period, today, tz);
  const currentKey = period === "week" ? dayKey(curStart, tz) : monthKey(curStart, tz);

  // The previous period is the one containing the instant just before the
  // current period's start. We anchor the series scan at the previous period's
  // OWN start so its full range is covered (one ms before is the last day of
  // the previous period, which would miss its earlier days).
  const prevInstant = new Date(curStart.getTime() - 1);
  const prevStart = currentStart(period, prevInstant, tz);
  const previousKey = period === "week" ? dayKey(prevStart, tz) : monthKey(prevStart, tz);

  // A series over [prevStart, today] covers both buckets in one pass.
  const pts = series(index, trackable, subjectIds, granularity, prevStart, today, tz);
  const byKey = new Map(pts.map((p) => [p.date, p.value]));
  const current = byKey.get(currentKey) ?? 0;
  const previous = byKey.get(previousKey) ?? 0;
  const deltaAbs = Math.round((current - previous) * 10) / 10;
  const deltaPct = previous === 0 ? null : Math.round((deltaAbs / previous) * 1000) / 10;
  return { current, previous, deltaAbs, deltaPct };
}

/** Start instant of the current period (week or month) containing `today`. */
function currentStart(period: "week" | "month", today: Date, tz: string): Date {
  return period === "week" ? startOfWeek(today, tz) : firstOfMonth(today, tz);
}
