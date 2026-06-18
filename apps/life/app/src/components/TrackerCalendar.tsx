/**
 * TrackerCalendar — the reusable Su–Sa multi-week grid that is the centerpiece
 * of the Habits lens. ONE component renders both goal calendars (with a goal
 * overlay coloring met/over days) and plain-trackable calendars (binary
 * logged/not).
 *
 * Layout: a day-of-week header row (S M T W T F S) over `weeks` week-rows, oldest
 * at the top and the CURRENT week at the bottom. The current week carries a today
 * marker (ring) on today's cell; days after today are muted + non-interactive
 * (you can't log the future).
 *
 * Cell coloring (see `cellState`):
 *   - empty                    → muted
 *   - logged, no goal          → neutral "filled"
 *   - at_least/frequency goal  → a day with ≥1 qualifying event → "met"
 *   - at_most (cap) goal       → a day whose qualifying SUM exceeds the daily
 *                                target → "over" (amber); logged-but-under-cap →
 *                                neutral filled.
 *
 * All day identity is tz-aware (buildCalendarGrid + the day index), so the cells
 * agree with the goal evaluator's day math. A SHORT tap on a non-future cell
 * fires `onTapDay(date, events)`; a LONG press fires `onLongPressDay(date,
 * events)` (defaults to `onTapDay` when omitted). The lens decides — by the
 * trackable's shape — whether a tap toggles (binary `happened`) or edits.
 */
import { useMemo } from "react";
import styled from "styled-components";
import type { LifeEvent, LifeGoal } from "@homelab/backend";
import { buildCalendarGrid, DOW_LABELS } from "../lib/calendarGrid";
import { dayHas, daySum, dayEvents, type DayIndex } from "../lib/dayIndex";
import { usePressHold } from "../lib/usePressHold";

export type CellKind = "empty" | "filled" | "met" | "over";

const Grid = styled.div`
  display: flex;
  flex-direction: column;
  gap: 3px;
`;

const Row = styled.div`
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 3px;
`;

const DowCell = styled.div`
  text-align: center;
  font-size: 10px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
`;

const Cell = styled.button<{
  $kind: CellKind;
  $future: boolean;
  $today: boolean;
  $inMonth: boolean;
}>`
  aspect-ratio: 1;
  min-width: 0;
  min-height: 22px;
  border-radius: var(--radius-sm, 6px);
  border: ${(p) => (p.$today ? "2px solid var(--color-primary)" : "1px solid transparent")};
  cursor: ${(p) => (p.$future ? "default" : "pointer")};
  padding: 0;
  /* Future days mute hardest; out-of-month days dim a bit so the reference
     month reads as the focus without hiding the surrounding context. */
  opacity: ${(p) => (p.$future ? 0.35 : p.$inMonth ? 1 : 0.45)};
  transition: background 0.1s;
  /* Center the day-of-month number. Empty/future cells keep dark-on-pale text;
     filled/met (cyan/green) flip to white. The over kind is amber, where
     white-on-amber is ~1.6:1 (illegible at 10px), so it keeps dark text -
     matching how amber pairs with dark text elsewhere (HabitBoard over-cap). */
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: ${(p) => {
    if (p.$future || p.$kind === "empty") return "var(--color-text-secondary)";
    // Amber over-cap needs a dark number for contrast; cyan/green take white.
    if (p.$kind === "over") return "var(--color-text, #1a1a1a)";
    return "#fff";
  }};
  background: ${(p) => {
    if (p.$future || p.$kind === "empty") return "var(--color-bg-muted, #f0f0f0)";
    if (p.$kind === "over") return "var(--color-warning, #faad14)";
    if (p.$kind === "met") return "var(--color-success, #52c41a)";
    return "var(--color-primary)"; // filled (plain logged / under-cap)
  }};

  &:hover {
    filter: ${(p) => (p.$future ? "none" : "brightness(0.95)")};
  }
  &:disabled {
    cursor: default;
  }
`;

export interface TrackerCalendarProps {
  /** Subjects whose events fill the calendar (1 for a thing, N for a group). */
  subjectIds: string[];
  /** When present, days are colored by the goal's adherence (met / over). */
  goal?: LifeGoal;
  /** How many calendar weeks to render (current week last). */
  weeks: number;
  index: DayIndex;
  tz: string;
  /** Any instant in the current local day. */
  today: Date;
  /** SHORT tap on a non-future cell — receives the day (local noon) + events. */
  onTapDay: (date: Date, events: LifeEvent[]) => void;
  /**
   * LONG press on a non-future cell. Same signature as `onTapDay`. When omitted,
   * a long press behaves like a tap (so callers that don't distinguish gestures
   * still work). The Habits lens passes this for `happened` things so a tap can
   * TOGGLE while a long press opens the full editor.
   */
  onLongPressDay?: (date: Date, events: LifeEvent[]) => void;
  /**
   * When set, cells outside this month are dimmed as adjacent-month days. Used by
   * the 6-week month grids in HabitHistory; omitted for the single-week board
   * strip (every cell is in-month).
   */
  monthRef?: Date;
}

/**
 * Resolve one cell's color class from the index + (optional) goal overlay.
 * at_most caps compare the day's qualifying SUM to the goal target (a per-day
 * cap); ≥-kinds (at_least/frequency) just need ≥1 qualifying event that day.
 */
export function cellState(
  index: DayIndex,
  subjectIds: string[],
  key: string,
  goal: LifeGoal | undefined,
): CellKind {
  const logged = dayHas(index, subjectIds, key);
  if (!logged) return "empty";
  if (!goal) return "filled";
  if (goal.kind === "at_most") {
    // The "over" overlay is a per-DAY breach signal, so it only makes sense for
    // a daily cap. For a weekly (or otherwise non-day) cap, comparing a single
    // day's quantity to the *period* target would mis-flag cells — the weekly
    // breach lives in the status row, so a logged day is just neutral "filled".
    if (goal.period !== "day") return "filled";
    // A daily cap is a per-day ceiling: over when the day's quantity exceeds it.
    // `sum` metric sums by unit; for count/days caps fall back to event count.
    const value =
      goal.metric === "sum" && goal.unit
        ? daySum(index, subjectIds, key, goal.unit)
        : countFor(index, subjectIds, key);
    return value > goal.target ? "over" : "filled";
  }
  // at_least / frequency: any qualifying day is a positive day.
  return "met";
}

/** Total event count across subjects on a day (for non-sum caps). */
function countFor(index: DayIndex, subjectIds: string[], key: string): number {
  let n = 0;
  for (const id of subjectIds) {
    const cell = index.get(id)?.get(key);
    if (cell) n += cell.count;
  }
  return n;
}

/**
 * One interactive day cell. Owns its own press-and-hold hook so tap vs
 * long-press are distinguished per cell (a tap toggles a `happened` thing; a
 * long press opens the editor). Future cells are inert.
 */
function DayButton({
  cell,
  kind,
  onTap,
  onLongPress,
}: {
  cell: import("../lib/calendarGrid").CalendarCell;
  kind: CellKind;
  onTap: () => void;
  onLongPress: () => void;
}) {
  const hold = usePressHold(onTap, onLongPress, cell.future);
  return (
    <Cell
      role="gridcell"
      $kind={kind}
      $future={cell.future}
      $today={cell.isToday}
      $inMonth={cell.inMonth}
      disabled={cell.future}
      data-testid="calendar-cell"
      data-daykey={cell.key}
      data-kind={kind}
      data-today={cell.isToday ? "true" : undefined}
      data-future={cell.future ? "true" : undefined}
      data-in-month={cell.inMonth ? undefined : "false"}
      aria-label={cell.key}
      {...hold}
    >
      {/* Day number derived from the tz-correct key (YYYY-MM-DD), NOT
          cell.date.getDate(): cell.date is a UTC instant equal to noon-in-tz, and
          getDate() reads the BROWSER's tz — east of the saved tz that lands on the
          next local day and prints an off-by-one number. */}
      {Number(cell.key.slice(8))}
    </Cell>
  );
}

export function TrackerCalendar({
  subjectIds,
  goal,
  weeks,
  index,
  tz,
  today,
  onTapDay,
  onLongPressDay,
  monthRef,
}: TrackerCalendarProps) {
  const grid = useMemo(
    () => buildCalendarGrid(today, weeks, tz, monthRef),
    [today, weeks, tz, monthRef],
  );
  const longPress = onLongPressDay ?? onTapDay;

  return (
    <Grid data-testid="tracker-calendar" role="grid" aria-label="Tracking calendar">
      <Row>
        {DOW_LABELS.map((d, i) => (
          <DowCell key={i} aria-hidden>
            {d}
          </DowCell>
        ))}
      </Row>
      {grid.map((week, wi) => (
        <Row key={wi} role="row">
          {week.map((cell) => {
            const kind = cell.future ? "empty" : cellState(index, subjectIds, cell.key, goal);
            return (
              <DayButton
                key={cell.key}
                cell={cell}
                kind={kind}
                onTap={() => onTapDay(cell.date, dayEvents(index, subjectIds, cell.key))}
                onLongPress={() => longPress(cell.date, dayEvents(index, subjectIds, cell.key))}
              />
            );
          })}
        </Row>
      ))}
    </Grid>
  );
}
