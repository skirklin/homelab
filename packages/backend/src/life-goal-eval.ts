/**
 * Pure goal evaluator — the SINGLE source of truth for "how is this goal
 * doing?", called by both the HabitBoard view (via the app's lib/goals
 * re-export) and the MCP progress route. It interprets existing `life_events`
 * against a goal definition; it never writes.
 *
 * All period math is in an EXPLICIT IANA timezone passed by the caller — never
 * the runtime tz. This matters because the same function runs in two places
 * with different runtime clocks: the browser (HabitBoard, local tz) and the
 * API `functions` pod (UTC, no TZ set). Computing boundaries in the runtime tz
 * made them disagree for events near midnight — a 6pm-Pacific event lands on
 * the next UTC day, so server progress and the dashboard would count it in
 * different days/weeks. By threading the same `timeZone` (the log owner's tz on
 * the server; `Intl…resolvedOptions().timeZone` in the browser) every boundary
 * — day start/end, Sunday-start week, the distinct-`days` dayKey, and the
 * streak period walk — is computed in that zone via date-fns-tz. Weeks are
 * Sunday-start, matching the life app's Visualizations / SessionStreakGrid.
 *
 * Qualifying events = events whose subjectId is the goal's `thing`, or (group
 * scope) any non-hidden trackable whose `group` matches PLUS the hidden husk
 * whose id equals the group name (the shape migration leaves a hidden
 * `{id:<group>, hidden:true, group:<group>}` so legacy `subjectId:<group>`
 * events still belong to the group) — within the period containing the ref
 * date. The metric then reduces them:
 *   count → number of qualifying events
 *   sum   → sum of the number entry whose `unit` === goal.unit (name-agnostic)
 *   days  → distinct local days in the period with ≥1 qualifying event
 */
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import type { LifeEvent, LifeManifestTrackable, LifeGoal } from "./types/life";

// ---------------------------------------------------------------------------
// Period boundaries (explicit IANA tz)
//
// toZonedTime(utc, tz) → a Date whose *runtime-local* fields read as the
// wall-clock time in `tz`. We mutate those fields to find the wall-clock
// boundary, then fromZonedTime(zoned, tz) maps it back to a true UTC instant.
// ---------------------------------------------------------------------------

/**
 * Start-of-day UTC instant for the day (in `tz`) containing `d`.
 *
 * Exported so the life app's day index buckets events with the EXACT same
 * tz-aware boundaries the goal evaluator uses — otherwise a calendar cell and
 * the goal math could disagree on which day an event near midnight lands in.
 */
export function startOfDay(d: Date, tz: string): Date {
  const z = toZonedTime(d, tz);
  z.setHours(0, 0, 0, 0);
  return fromZonedTime(z, tz);
}

/** End-of-day UTC instant (last ms) for the day (in `tz`) containing `d`. */
export function endOfDay(d: Date, tz: string): Date {
  const z = toZonedTime(d, tz);
  z.setHours(23, 59, 59, 999);
  return fromZonedTime(z, tz);
}

/** Local-day key "YYYY-MM-DD" (in `tz`) for distinct-day counting. */
export function dayKey(d: Date, tz: string): string {
  const z = toZonedTime(d, tz);
  const y = z.getFullYear();
  const m = String(z.getMonth() + 1).padStart(2, "0");
  const day = String(z.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The UTC instant for wall-clock `hour:minute` on the day (in `tz`) containing
 * `d`. Used by the life app's backfill: a tapped past day + a picked time must
 * land in that day's user-tz bucket, even when the browser tz differs from the
 * user's tz. Builds off the day's start-of-day in `tz`, so DST transitions are
 * handled by date-fns-tz rather than naive ms arithmetic.
 */
export function zonedDateTime(d: Date, hour: number, minute: number, tz: string): Date {
  const z = toZonedTime(d, tz);
  z.setHours(hour, minute, 0, 0);
  return fromZonedTime(z, tz);
}

/** Start of the Sunday-start week (in `tz`) containing `d`, as a UTC instant. */
export function startOfWeek(d: Date, tz: string): Date {
  const z = toZonedTime(d, tz);
  z.setHours(0, 0, 0, 0);
  z.setDate(z.getDate() - z.getDay()); // getDay: Sun=0 → no shift
  return fromZonedTime(z, tz);
}

/** End of the Sunday-start week (in `tz`) containing `d`, as a UTC instant. */
function endOfWeek(d: Date, tz: string): Date {
  const z = toZonedTime(d, tz);
  z.setHours(23, 59, 59, 999);
  z.setDate(z.getDate() + (6 - z.getDay()));
  return fromZonedTime(z, tz);
}

/** [start, end] of the period (day|week) containing `ref`, in `tz`. */
function periodBounds(period: LifeGoal["period"], ref: Date, tz: string): { start: Date; end: Date } {
  return period === "week"
    ? { start: startOfWeek(ref, tz), end: endOfWeek(ref, tz) }
    : { start: startOfDay(ref, tz), end: endOfDay(ref, tz) };
}

/** Step `ref` back by one whole period (in `tz`), for the streak walk-back. */
function prevPeriodRef(period: LifeGoal["period"], ref: Date, tz: string): Date {
  const z = toZonedTime(ref, tz);
  z.setDate(z.getDate() - (period === "week" ? 7 : 1));
  return fromZonedTime(z, tz);
}

export interface GoalProgress {
  value: number;
  target: number;
  kind: LifeGoal["kind"];
  metric: LifeGoal["metric"];
  /** at_least/frequency: value ≥ target. at_most: value ≤ target. */
  met: boolean;
  /**
   * ≥-kinds (at_least/frequency): max(0, target − value) — how much more to go.
   * at_most: max(0, target − value) — headroom before the cap breaks.
   */
  remaining: number;
  periodStart: Date;
  periodEnd: Date;
  /** Consecutive prior periods (ending at the ref period) that were met. */
  streak: number;
}

// ---------------------------------------------------------------------------
// Qualifying events + value
// ---------------------------------------------------------------------------

/** The set of subjectIds a goal's scope selects (thing → 1, group → members). */
function scopeSubjectIds(goal: LifeGoal, trackables: LifeManifestTrackable[]): Set<string> {
  if ("thing" in goal.scope) return new Set([goal.scope.thing]);
  const group = goal.scope.group;
  // Include the hidden husk whose id === group: the shape migration keeps a
  // hidden `{id:<group>, hidden:true, group:<group>}` so legacy
  // `subjectId:<group>` events still count toward the group. Other hidden
  // members are excluded.
  return new Set(
    trackables
      .filter((t) => t.group === group && (!t.hidden || t.id === group))
      .map((t) => t.id),
  );
}

function qualifyingEvents(
  events: LifeEvent[],
  subjectIds: Set<string>,
  start: Date,
  end: Date,
): LifeEvent[] {
  return events.filter(
    (e) => subjectIds.has(e.subjectId) && e.timestamp >= start && e.timestamp <= end,
  );
}

/** Reduce qualifying events to the goal's metric value (in `tz` for days). */
function metricValue(goal: LifeGoal, qualifying: LifeEvent[], tz: string): number {
  if (goal.metric === "count") return qualifying.length;
  if (goal.metric === "days") {
    const days = new Set<string>();
    for (const e of qualifying) days.add(dayKey(e.timestamp, tz));
    return days.size;
  }
  // sum: name-agnostically sum every number entry whose unit matches goal.unit.
  let total = 0;
  for (const e of qualifying) {
    for (const entry of e.entries) {
      if (entry.type === "number" && entry.unit === goal.unit) total += entry.value;
    }
  }
  return total;
}

function isMet(kind: LifeGoal["kind"], value: number, target: number): boolean {
  return kind === "at_most" ? value <= target : value >= target;
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

/** Max periods to walk back when computing a streak (safety bound). */
const MAX_STREAK_LOOKBACK = 366;

/**
 * Evaluate one goal for the period containing `refDate` (default now), plus its
 * streak — consecutive prior periods (ending at refDate's period) that were
 * met. The current period counts toward the streak only if it is itself met,
 * so an in-progress day that hasn't hit its target yet doesn't inflate it.
 *
 * Streak semantics: "consecutive periods kept since you started tracking it."
 * The walk-back stops at the period containing the EARLIEST qualifying event —
 * periods before any data exist don't count. This matters for `at_most` caps,
 * where a vacuously-empty prior period satisfies `value ≤ target` and would
 * otherwise credit every period back to the lookback bound (a brand-new cap
 * would show a 366-day streak). With no qualifying events at all the streak is
 * 0.
 *
 * @param timeZone IANA tz (e.g. "America/Los_Angeles") for ALL boundary math.
 */
export function evaluateGoal(
  goal: LifeGoal,
  events: LifeEvent[],
  trackables: LifeManifestTrackable[],
  timeZone: string,
  refDate: Date = new Date(),
): GoalProgress {
  const subjectIds = scopeSubjectIds(goal, trackables);
  const { start, end } = periodBounds(goal.period, refDate, timeZone);
  const value = metricValue(goal, qualifyingEvents(events, subjectIds, start, end), timeZone);
  const met = isMet(goal.kind, value, goal.target);
  const remaining = Math.max(0, goal.target - value);

  // Earliest qualifying event bounds the streak back-walk: periods before the
  // first data point are not part of the active tracking range, so they never
  // count. (Without this, an empty `at_most` period vacuously "meets" the cap.)
  let earliest: Date | undefined;
  for (const e of events) {
    if (subjectIds.has(e.subjectId) && (!earliest || e.timestamp < earliest)) {
      earliest = e.timestamp;
    }
  }
  const earliestPeriodStart = earliest
    ? periodBounds(goal.period, earliest, timeZone).start
    : undefined;

  // Streak: walk back period-by-period while each is met AND within the active
  // range (≥ the earliest qualifying event's period). Start at the ref period
  // (counts only if met), then keep stepping back.
  let streak = 0;
  let cursor = refDate;
  for (let i = 0; i < MAX_STREAK_LOOKBACK; i++) {
    const b = periodBounds(goal.period, cursor, timeZone);
    // Stop once we step before the first tracked period (empty history ⇒ 0).
    if (!earliestPeriodStart || b.start < earliestPeriodStart) break;
    const v = metricValue(goal, qualifyingEvents(events, subjectIds, b.start, b.end), timeZone);
    if (!isMet(goal.kind, v, goal.target)) break;
    streak += 1;
    cursor = prevPeriodRef(goal.period, cursor, timeZone);
  }

  return {
    value,
    target: goal.target,
    kind: goal.kind,
    metric: goal.metric,
    met,
    remaining,
    periodStart: start,
    periodEnd: end,
    streak,
  };
}
