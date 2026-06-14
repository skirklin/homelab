/**
 * GitHub-contributions-style year heatmap: 7 day-rows (Sunday at top) × ~53
 * week-columns ending at the current week. It is a TRANSPOSED TrackerCalendar —
 * same tz-aware day buckets, same `cellState` coloring (empty / filled / met /
 * over), same tap/long-press interactions — so there is ONE source of truth for
 * how a day is colored.
 *
 * Layout note: a column is a Su–Sa week; the last column is the current week, so
 * future days in it render muted + inert (you can't log the future).
 */
import { useMemo } from "react";
import styled from "styled-components";
import type { LifeEvent, LifeGoal } from "@homelab/backend";
import { dayKey, startOfWeek } from "@homelab/backend";
import { dayEvents, type DayIndex } from "../lib/dayIndex";
import { cellState, type CellKind } from "./TrackerCalendar";
import { usePressHold } from "../lib/usePressHold";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const Scroll = styled.div`
  overflow-x: auto;
  padding-bottom: 4px;
`;

const Cols = styled.div`
  display: flex;
  gap: 3px;
  width: max-content;
`;

const Col = styled.div`
  display: flex;
  flex-direction: column;
  gap: 3px;
`;

const HeatCell = styled.button<{ $kind: CellKind; $future: boolean; $today: boolean }>`
  width: 13px;
  height: 13px;
  border-radius: 3px;
  padding: 0;
  border: ${(p) => (p.$today ? "2px solid var(--color-primary)" : "1px solid transparent")};
  cursor: ${(p) => (p.$future ? "default" : "pointer")};
  opacity: ${(p) => (p.$future ? 0.3 : 1)};
  background: ${(p) => {
    if (p.$future || p.$kind === "empty") return "var(--color-bg-muted, #ebedf0)";
    if (p.$kind === "over") return "var(--color-warning, #faad14)";
    if (p.$kind === "met") return "var(--color-success, #52c41a)";
    return "var(--color-primary)";
  }};
`;

interface HeatDay {
  date: Date;
  key: string;
  future: boolean;
  isToday: boolean;
}

/**
 * Build `weeks` Su–Sa columns ending with the current week. Each column has 7
 * day-slots (Sun..Sat); columns always start on a Sunday so the grid is a clean
 * 7×weeks rectangle (no ragged edges to pad).
 */
function buildHeatGrid(today: Date, weeks: number, tz: string): HeatDay[][] {
  const todayKey = dayKey(today, tz);
  const thisWeekStart = startOfWeek(today, tz);
  const cols: HeatDay[][] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    // Step back whole weeks; re-snap to a Sunday so DST can't drift the column.
    const weekStart = startOfWeek(new Date(thisWeekStart.getTime() - w * 7 * DAY_MS), tz);
    const col: HeatDay[] = [];
    for (let d = 0; d < 7; d++) {
      // Local noon of the d-th day — a DST-safe day representative + the tap
      // timestamp (matches buildCalendarGrid's contract).
      const date = new Date(weekStart.getTime() + d * DAY_MS + 12 * HOUR_MS);
      const key = dayKey(date, tz);
      col.push({
        date,
        key,
        future: key > todayKey,
        isToday: key === todayKey,
      });
    }
    cols.push(col);
  }
  return cols;
}

function HeatButton({
  day,
  kind,
  onTap,
  onLongPress,
}: {
  day: HeatDay;
  kind: CellKind;
  onTap: () => void;
  onLongPress: () => void;
}) {
  const hold = usePressHold(onTap, onLongPress, day.future);
  return (
    <HeatCell
      $kind={kind}
      $future={day.future}
      $today={day.isToday}
      disabled={day.future}
      data-testid="heatmap-cell"
      data-daykey={day.key}
      data-kind={kind}
      data-today={day.isToday ? "true" : undefined}
      aria-label={day.key}
      {...hold}
    />
  );
}

export interface YearHeatmapProps {
  subjectIds: string[];
  goal: LifeGoal | undefined;
  index: DayIndex;
  tz: string;
  today: Date;
  /** Number of week-columns (default ~53 = one year). */
  weeks?: number;
  onTapDay: (date: Date, events: LifeEvent[]) => void;
  onLongPressDay?: (date: Date, events: LifeEvent[]) => void;
}

export function YearHeatmap({
  subjectIds,
  goal,
  index,
  tz,
  today,
  weeks = 53,
  onTapDay,
  onLongPressDay,
}: YearHeatmapProps) {
  const cols = useMemo(() => buildHeatGrid(today, weeks, tz), [today, weeks, tz]);
  const longPress = onLongPressDay ?? onTapDay;
  return (
    <Scroll data-testid="year-heatmap">
      <Cols>
        {cols.map((col, ci) => (
          <Col key={ci}>
            {col.map((day) => {
              const kind = day.future ? "empty" : cellState(index, subjectIds, day.key, goal);
              return (
                <HeatButton
                  key={day.key}
                  day={day}
                  kind={kind}
                  onTap={() => onTapDay(day.date, dayEvents(index, subjectIds, day.key))}
                  onLongPress={() => longPress(day.date, dayEvents(index, subjectIds, day.key))}
                />
              );
            })}
          </Col>
        ))}
      </Cols>
    </Scroll>
  );
}
