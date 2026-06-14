/**
 * Pure, tz-aware stat helpers for the per-habit history screen. Everything reads
 * from the already-built `DayIndex` (no event re-scans per cell) and buckets via
 * the SAME `@homelab/backend` tz helpers the goal evaluator uses, so a stat and
 * the calendar coloring agree on day/week identity.
 *
 * "Completed period" definition:
 *   - no goal            → a DAY with ≥1 event for the thing.
 *   - daily goal         → a DAY that is `met` (evaluator semantics).
 *   - weekly goal        → a WEEK that is `met` (evaluator semantics).
 *
 * For weekly goals the "period" is a week; for everything else it's a day. The
 * longest-streak walk bounds itself to [earliest event period .. today] so it
 * never walks infinitely (and an `at_most` cap's vacuously-met empty future
 * periods can't inflate it).
 */
import type { DayIndex } from "./dayIndex";
import { dayHas, daySum } from "./dayIndex";
import type { LifeEvent, LifeGoal } from "@homelab/backend";
import { dayKey, startOfDay, endOfDay, startOfWeek } from "@homelab/backend";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Next local day's start instant (DST-safe: +26h then re-snap to midnight). */
function nextDayStart(dayStart: Date, tz: string): Date {
  return startOfDay(new Date(dayStart.getTime() + 26 * HOUR_MS), tz);
}

/** Next local week's start instant (DST-safe: +8d then re-snap to Sunday). */
function nextWeekStart(weekStart: Date, tz: string): Date {
  return startOfWeek(new Date(weekStart.getTime() + 8 * DAY_MS), tz);
}

/** End of a week given its start instant. */
function weekEndOf(weekStart: Date, tz: string): Date {
  // Last ms of the 7th day. +6.5 days lands inside Saturday under any DST jump.
  return endOfDay(new Date(weekStart.getTime() + 6 * DAY_MS + 12 * HOUR_MS), tz);
}

// ---------------------------------------------------------------------------
// Qualifying-subject resolution (mirrors the evaluator's scope, but the history
// screen is always thing-scoped, so the subject set is just the one id).
// ---------------------------------------------------------------------------

/**
 * Is the period starting at `start` "met"? Without a goal, met = the day has any
 * event. With a daily goal, met by the goal's metric over that day. With a
 * weekly goal, met by the metric over the whole week (a single dayStart whose
 * week we evaluate).
 */
function periodMet(
  subjectIds: string[],
  goal: LifeGoal | null,
  periodStart: Date,
  tz: string,
  events: LifeEvent[],
  index: DayIndex,
): boolean {
  if (!goal) {
    // Plain trackable: a completed day = a day with ≥1 event.
    return dayHas(index, subjectIds, dayKey(periodStart, tz));
  }
  if (goal.period === "week") {
    const start = periodStart;
    const end = weekEndOf(periodStart, tz);
    const value = metricOver(goal, subjectIds, start, end, tz, events);
    return isMet(goal.kind, value, goal.target);
  }
  // Daily goal: metric over the single day.
  const key = dayKey(periodStart, tz);
  let value: number;
  if (goal.metric === "sum" && goal.unit) {
    value = daySum(index, subjectIds, key, goal.unit);
  } else if (goal.metric === "count") {
    value = countOver(subjectIds, startOfDay(periodStart, tz), endOfDay(periodStart, tz), events);
  } else {
    // days metric on a daily period: 1 if the day has any event, else 0.
    value = dayHas(index, subjectIds, key) ? 1 : 0;
  }
  return isMet(goal.kind, value, goal.target);
}

function isMet(kind: LifeGoal["kind"], value: number, target: number): boolean {
  return kind === "at_most" ? value <= target : value >= target;
}

/** Count of qualifying events in [start,end]. */
function countOver(subjectIds: string[], start: Date, end: Date, events: LifeEvent[]): number {
  let n = 0;
  const set = new Set(subjectIds);
  for (const e of events) {
    if (set.has(e.subjectId) && e.timestamp >= start && e.timestamp <= end) n += 1;
  }
  return n;
}

/** The goal's metric value over an arbitrary [start,end] window (for weeks). */
function metricOver(
  goal: LifeGoal,
  subjectIds: string[],
  start: Date,
  end: Date,
  tz: string,
  events: LifeEvent[],
): number {
  const set = new Set(subjectIds);
  const qualifying = events.filter(
    (e) => set.has(e.subjectId) && e.timestamp >= start && e.timestamp <= end,
  );
  if (goal.metric === "count") return qualifying.length;
  if (goal.metric === "days") {
    const days = new Set<string>();
    for (const e of qualifying) days.add(dayKey(e.timestamp, tz));
    return days.size;
  }
  let total = 0;
  for (const e of qualifying) {
    for (const entry of e.entries) {
      if (entry.type === "number" && entry.unit === goal.unit) total += entry.value;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Earliest event → lower bound for any history walk.
// ---------------------------------------------------------------------------

function earliestTimestamp(subjectIds: string[], events: LifeEvent[]): Date | undefined {
  const set = new Set(subjectIds);
  let earliest: Date | undefined;
  for (const e of events) {
    if (set.has(e.subjectId) && (!earliest || e.timestamp < earliest)) earliest = e.timestamp;
  }
  return earliest;
}

// ---------------------------------------------------------------------------
// Longest + current streak (consecutive met periods).
// ---------------------------------------------------------------------------

export interface StreakStats {
  current: number;
  longest: number;
}

/** Safety bound so a corrupt clock can't loop forever (~3 years of days). */
const MAX_PERIODS = 1100;

/**
 * Longest AND current run of consecutive met periods over [earliest .. today].
 * Daily goals (and plain trackables) walk days; weekly goals walk weeks. The
 * walk starts at the earliest event's period and steps forward to the period
 * containing `today`; `current` is the trailing run ending at today's period.
 */
export function computeStreaks(
  subjectIds: string[],
  goal: LifeGoal | null,
  index: DayIndex,
  events: LifeEvent[],
  tz: string,
  today: Date,
): StreakStats {
  const earliest = earliestTimestamp(subjectIds, events);
  if (!earliest) return { current: 0, longest: 0 };

  const weekly = goal?.period === "week";
  const periodStart = (d: Date) => (weekly ? startOfWeek(d, tz) : startOfDay(d, tz));
  const stepNext = (d: Date) => (weekly ? nextWeekStart(d, tz) : nextDayStart(d, tz));

  const firstStart = periodStart(earliest);
  const todayStart = periodStart(today);

  let longest = 0;
  let run = 0;
  let current = 0;
  let cursor = firstStart;
  for (let i = 0; i < MAX_PERIODS; i++) {
    const met = periodMet(subjectIds, goal, cursor, tz, events, index);
    if (met) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
    // The trailing run ending at today's period is the "current" streak.
    if (cursor.getTime() === todayStart.getTime()) {
      current = run;
      break;
    }
    if (cursor.getTime() > todayStart.getTime()) break;
    cursor = stepNext(cursor);
  }
  return { current, longest };
}

// ---------------------------------------------------------------------------
// Per-month + per-year completion stats.
// ---------------------------------------------------------------------------

export interface MonthStats {
  /** Days in this month with a "completed" period (event / met day). */
  completed: number;
  /** Days of the month that have elapsed (≤ today); full count for past months. */
  elapsed: number;
  /** completed / elapsed as a 0..100 percentage (0 when elapsed is 0). */
  pct: number;
}

/**
 * Completed vs elapsed days for the local month containing `monthRef`. "Completed"
 * uses the daily `periodMet` (so a daily goal counts met days, a plain trackable
 * counts logged days). Weekly goals: a day counts as completed if its WEEK is met
 * — a coarse but useful month view; the week-accurate streaks live above.
 */
export function monthStats(
  subjectIds: string[],
  goal: LifeGoal | null,
  index: DayIndex,
  events: LifeEvent[],
  tz: string,
  monthRef: Date,
  today: Date,
): MonthStats {
  // Walk every local day of the month, stopping at today (inclusive).
  const firstKey = monthKey(monthRef, tz);
  const todayKey = dayKey(today, tz);
  let cursor = startOfDay(firstOfMonth(monthRef, tz), tz);
  let completed = 0;
  let elapsed = 0;
  for (let i = 0; i < 40; i++) {
    if (monthKey(cursor, tz) !== firstKey) break; // rolled into next month
    if (dayKey(cursor, tz) > todayKey) break; // future days don't count
    elapsed += 1;
    if (dayCompleted(subjectIds, goal, cursor, tz, events, index)) completed += 1;
    cursor = nextDayStart(cursor, tz);
  }
  const pct = elapsed > 0 ? Math.round((completed / elapsed) * 100) : 0;
  return { completed, elapsed, pct };
}

/**
 * Is a single local DAY "completed"? Weekly goals: the day's WEEK is met (coarse
 * but useful in a month view). Else: the daily `periodMet`.
 */
function dayCompleted(
  subjectIds: string[],
  goal: LifeGoal | null,
  dayStart: Date,
  tz: string,
  events: LifeEvent[],
  index: DayIndex,
): boolean {
  const ref = goal?.period === "week" ? startOfWeek(dayStart, tz) : dayStart;
  return periodMet(subjectIds, goal, ref, tz, events, index);
}

export interface YearStats {
  /** Distinct completed days over the trailing 12 months (to today). */
  completedDays: number;
  /** Elapsed days in that window with data range (earliest event .. today). */
  elapsedDays: number;
  pct: number;
  current: number;
  longest: number;
}

/**
 * Year totals over the window [max(earliest, today−364d) .. today]: completed
 * days, completion %, plus current & longest streak (period-correct via
 * computeStreaks). Bounds to the earliest event so a brand-new habit doesn't
 * show a denominator of 365.
 */
export function yearStats(
  subjectIds: string[],
  goal: LifeGoal | null,
  index: DayIndex,
  events: LifeEvent[],
  tz: string,
  today: Date,
): YearStats {
  const streaks = computeStreaks(subjectIds, goal, index, events, tz, today);
  const earliest = earliestTimestamp(subjectIds, events);
  if (!earliest) {
    return { completedDays: 0, elapsedDays: 0, pct: 0, current: 0, longest: 0 };
  }
  // Window start = later of (earliest event day, 364 days ago).
  const windowStartCandidate = startOfDay(new Date(today.getTime() - 364 * DAY_MS), tz);
  const earliestDay = startOfDay(earliest, tz);
  let cursor = earliestDay > windowStartCandidate ? earliestDay : windowStartCandidate;
  const todayKey = dayKey(today, tz);
  let completedDays = 0;
  let elapsedDays = 0;
  for (let i = 0; i < 400; i++) {
    const key = dayKey(cursor, tz);
    if (key > todayKey) break;
    elapsedDays += 1;
    if (dayCompleted(subjectIds, goal, cursor, tz, events, index)) completedDays += 1;
    cursor = nextDayStart(cursor, tz);
  }
  const pct = elapsedDays > 0 ? Math.round((completedDays / elapsedDays) * 100) : 0;
  return { completedDays, elapsedDays, pct, current: streaks.current, longest: streaks.longest };
}

// ---------------------------------------------------------------------------
// Local month helpers (tz-aware).
// ---------------------------------------------------------------------------

/** Local "YYYY-MM" key for the month containing `d`. */
export function monthKey(d: Date, tz: string): string {
  return dayKey(d, tz).slice(0, 7);
}

/** Start-of-day instant for the 1st of the local month containing `d`. */
function firstOfMonth(d: Date, tz: string): Date {
  // Step back day-by-day (DST-safe: −12h then re-snap) until the date is the 1st.
  let cursor = startOfDay(d, tz);
  for (let i = 0; i < 40; i++) {
    if (dayKey(cursor, tz).endsWith("-01")) break;
    cursor = startOfDay(new Date(cursor.getTime() - 12 * HOUR_MS), tz);
  }
  return cursor;
}

/** Step to the first day of the previous local month (for month pagination). */
export function prevMonth(d: Date, tz: string): Date {
  const first = firstOfMonth(d, tz);
  // One day before the 1st is the last day of the previous month; snap to its 1st.
  return firstOfMonth(new Date(first.getTime() - 12 * HOUR_MS), tz);
}

/** Human "June 2026" label for a month, tz-correct. */
export function monthLabel(d: Date, tz: string): string {
  const [y, m] = monthKey(d, tz).split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
