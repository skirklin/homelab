/**
 * Pure goal evaluator — the SINGLE source of truth for "how is this goal
 * doing?", called by both the HabitBoard view (via the app's lib/goals
 * re-export) and the MCP progress route. It interprets existing `life_events`
 * against a goal definition; it never writes.
 *
 * All period math is in the runtime-LOCAL timezone (the same convention the
 * dashboard's day nav and DayTimeline use; the API service runs in the user's
 * configured tz). Weeks are Sunday-start, matching the life app's Visualizations
 * / SessionStreakGrid.
 *
 * Qualifying events = events whose subjectId is the goal's `thing`, or (group
 * scope) any non-hidden trackable whose `group` matches — within the period
 * containing the ref date. The metric then reduces them:
 *   count → number of qualifying events
 *   sum   → sum of the number entry whose `unit` === goal.unit (name-agnostic)
 *   days  → distinct local days in the period with ≥1 qualifying event
 */
import type { LifeEvent, LifeManifestTrackable, LifeGoal } from "./types/life";

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
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
// Period boundaries (local tz)
// ---------------------------------------------------------------------------

/** Local-day key "YYYY-MM-DD" for distinct-day counting + day comparison. */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Sunday-start week containing `d` (local tz). */
function startOfWeek(d: Date): Date {
  const out = startOfDay(d);
  out.setDate(out.getDate() - out.getDay()); // getDay: Sun=0 → no shift
  return out;
}

function endOfWeek(d: Date): Date {
  const start = startOfWeek(d);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return endOfDay(end);
}

/** [start, end] of the period (day|week) containing `ref`, in local tz. */
function periodBounds(period: LifeGoal["period"], ref: Date): { start: Date; end: Date } {
  return period === "week"
    ? { start: startOfWeek(ref), end: endOfWeek(ref) }
    : { start: startOfDay(ref), end: endOfDay(ref) };
}

/** Step `ref` back by one whole period (used for streak walk-back). */
function prevPeriodRef(period: LifeGoal["period"], ref: Date): Date {
  const out = new Date(ref);
  out.setDate(out.getDate() - (period === "week" ? 7 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// Qualifying events + value
// ---------------------------------------------------------------------------

/** The set of subjectIds a goal's scope selects (thing → 1, group → members). */
function scopeSubjectIds(goal: LifeGoal, trackables: LifeManifestTrackable[]): Set<string> {
  if ("thing" in goal.scope) return new Set([goal.scope.thing]);
  const group = goal.scope.group;
  return new Set(trackables.filter((t) => !t.hidden && t.group === group).map((t) => t.id));
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

/** Reduce qualifying events to the goal's metric value. */
function metricValue(goal: LifeGoal, qualifying: LifeEvent[]): number {
  if (goal.metric === "count") return qualifying.length;
  if (goal.metric === "days") {
    const days = new Set<string>();
    for (const e of qualifying) days.add(dayKey(e.timestamp));
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
 */
export function evaluateGoal(
  goal: LifeGoal,
  events: LifeEvent[],
  trackables: LifeManifestTrackable[],
  refDate: Date = new Date(),
): GoalProgress {
  const subjectIds = scopeSubjectIds(goal, trackables);
  const { start, end } = periodBounds(goal.period, refDate);
  const value = metricValue(goal, qualifyingEvents(events, subjectIds, start, end));
  const met = isMet(goal.kind, value, goal.target);
  const remaining = Math.max(0, goal.target - value);

  // Streak: walk back period-by-period while each is met. Start at the ref
  // period (counts only if met), then keep stepping back.
  let streak = 0;
  let cursor = refDate;
  for (let i = 0; i < MAX_STREAK_LOOKBACK; i++) {
    const b = periodBounds(goal.period, cursor);
    const v = metricValue(goal, qualifyingEvents(events, subjectIds, b.start, b.end));
    if (!isMet(goal.kind, v, goal.target)) break;
    streak += 1;
    cursor = prevPeriodRef(goal.period, cursor);
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
