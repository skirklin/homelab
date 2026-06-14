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
 * agree with the goal evaluator's day math. Tapping a non-future cell fires
 * `onTapDay(date, events)` — the lens decides whether to backfill or edit.
 */
import { useMemo } from "react";
import styled from "styled-components";
import type { LifeEvent, LifeGoal } from "@homelab/backend";
import { buildCalendarGrid, DOW_LABELS } from "../lib/calendarGrid";
import { dayHas, daySum, dayEvents, type DayIndex } from "../lib/dayIndex";

type CellKind = "empty" | "filled" | "met" | "over";

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

const Cell = styled.button<{ $kind: CellKind; $future: boolean; $today: boolean }>`
  aspect-ratio: 1;
  min-width: 0;
  min-height: 22px;
  border-radius: var(--radius-sm, 6px);
  border: ${(p) => (p.$today ? "2px solid var(--color-primary)" : "1px solid transparent")};
  cursor: ${(p) => (p.$future ? "default" : "pointer")};
  padding: 0;
  opacity: ${(p) => (p.$future ? 0.35 : 1)};
  transition: background 0.1s;
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
  /** Tapped a non-future cell — receives the day (local noon) + its events. */
  onTapDay: (date: Date, events: LifeEvent[]) => void;
}

/**
 * Resolve one cell's color class from the index + (optional) goal overlay.
 * at_most caps compare the day's qualifying SUM to the goal target (a per-day
 * cap); ≥-kinds (at_least/frequency) just need ≥1 qualifying event that day.
 */
function cellState(
  index: DayIndex,
  subjectIds: string[],
  key: string,
  goal: LifeGoal | undefined,
): CellKind {
  const logged = dayHas(index, subjectIds, key);
  if (!logged) return "empty";
  if (!goal) return "filled";
  if (goal.kind === "at_most") {
    // A cap is a daily ceiling: over when the day's summed quantity exceeds it.
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

export function TrackerCalendar({
  subjectIds,
  goal,
  weeks,
  index,
  tz,
  today,
  onTapDay,
}: TrackerCalendarProps) {
  const grid = useMemo(() => buildCalendarGrid(today, weeks, tz), [today, weeks, tz]);

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
              <Cell
                key={cell.key}
                role="gridcell"
                $kind={kind}
                $future={cell.future}
                $today={cell.isToday}
                disabled={cell.future}
                data-testid="calendar-cell"
                data-daykey={cell.key}
                data-kind={kind}
                data-today={cell.isToday ? "true" : undefined}
                data-future={cell.future ? "true" : undefined}
                aria-label={cell.key}
                onClick={() => {
                  if (cell.future) return;
                  onTapDay(cell.date, dayEvents(index, subjectIds, cell.key));
                }}
              />
            );
          })}
        </Row>
      ))}
    </Grid>
  );
}
