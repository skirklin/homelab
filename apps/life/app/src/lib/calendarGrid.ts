/**
 * Build the Su–Sa calendar grid for the TrackerCalendar — a list of week-rows,
 * oldest first, the current week last. All day identity is tz-aware via the
 * shared `startOfWeek` / `dayKey` helpers (no runtime setHours bucketing).
 *
 * A cell's `date` is local noon of that day, chosen so:
 *   - it's a stable representative instant inside the day for tap-to-log
 *     backfill (noon lands in the right local day under any DST shift, and the
 *     ShapeSheet already treats past-day logs as noon);
 *   - advancing the week-start instant by `dayOffset*24h + 12h` can't cross a
 *     day boundary even with a ±1h DST jump, so the derived `dayKey` is correct.
 */
import { dayKey, startOfWeek } from "@homelab/backend";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOON_MS = 12 * 60 * 60 * 1000;

export interface CalendarCell {
  /** Local noon of this day — the backfill timestamp + day representative. */
  date: Date;
  /** Tz-aware "YYYY-MM-DD" key into the day index. */
  key: string;
  /** Strictly after today's local day → can't log the future. */
  future: boolean;
  /** This cell IS today's local day → render the today marker. */
  isToday: boolean;
}

export type CalendarWeek = CalendarCell[]; // length 7, Sun..Sat

/**
 * `weeks` calendar weeks ending with the week containing `today`, oldest first.
 * `tz` is the user's IANA zone; `today` is any instant in the current day.
 */
export function buildCalendarGrid(today: Date, weeks: number, tz: string): CalendarWeek[] {
  const todayKey = dayKey(today, tz);
  const thisWeekStart = startOfWeek(today, tz); // UTC instant at local Sunday 00:00
  const rows: CalendarWeek[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    // Step back whole weeks from the start instant. 7*DAY_MS is exact in UTC ms;
    // we only ever read the derived day via the tz-aware dayKey below.
    const weekStart = new Date(thisWeekStart.getTime() - w * 7 * DAY_MS);
    const row: CalendarWeek = [];
    for (let d = 0; d < 7; d++) {
      // Local noon of the d-th day of this week (DST-safe day identity).
      const date = new Date(weekStart.getTime() + d * DAY_MS + NOON_MS);
      const key = dayKey(date, tz);
      row.push({
        date,
        key,
        future: key > todayKey,
        isToday: key === todayKey,
      });
    }
    rows.push(row);
  }
  return rows;
}

export const DOW_LABELS = ["S", "M", "T", "W", "T", "F", "S"] as const;
