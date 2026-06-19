/**
 * Last-8-weeks session grid for the life dashboard StreakCard.
 *
 * 8 columns × 7 rows, columns = weeks (oldest → newest left → right), rows =
 * day-of-week (Sun on top). The rightmost column ends at the current week, so
 * "today" is always visible at its weekday row.
 *
 * Each cell is split along the anti-diagonal (top-right → bottom-left): the
 * top-left triangle = morning session, the bottom-right triangle = evening
 * session. Each half is either teal (logged) or muted (not logged). A fully
 * muted cell = nothing logged that day; a fully teal cell = both sessions
 * logged.
 *
 * Pure CSS grid; the diagonal split is a single hard-stop linear-gradient. No
 * chart library, no horizontal scrolling — the grid is sized to fit any
 * StreakCard width.
 *
 * Day identity is tz-aware (the shared `dayKey`/`buildCalendarGrid` helpers, the
 * SAME ones the goal evaluator + day index use); there is no local setHours
 * bucketing here. This is a completion-history grid, not a streak counter.
 */
import { useMemo } from "react";
import styled from "styled-components";
import { Tooltip } from "antd";
import dayjs from "dayjs";
import type { LifeEvent, SessionView } from "@homelab/backend";
import { dayKey, normalizeSessionRuns } from "@homelab/backend";
import { buildCalendarGrid } from "../lib/calendarGrid";

const WEEKS = 8;
const CELL_PX = 14;
const GAP_PX = 3;
const LOGGED_COLOR = "#13c2c2";
// Sundays use the weekly-review color in the bottom-right triangle slot
// instead of the evening color — weekly review subsumes evening reflection
// on Sundays, and the distinct hue makes "weekly recap done" visually
// readable at a glance on the year board.
const WEEKLY_COLOR = "#722ed1";
const MUTED_COLOR = "var(--color-bg-muted, #f0f0f0)";

/**
 * `linear-gradient(135deg, A 50%, B 50%)` puts a hard split along the
 * anti-diagonal: A fills the top-left triangle, B fills the bottom-right.
 * Colors are passed in directly so the caller can pick LOGGED_COLOR (regular
 * morning/evening), WEEKLY_COLOR (Sunday weekly review), or MUTED_COLOR
 * (not logged) per triangle.
 */
function splitBg(topColor: string, bottomColor: string): string {
  return `linear-gradient(135deg, ${topColor} 50%, ${bottomColor} 50%)`;
}

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
`;

const Grid = styled.div`
  display: grid;
  grid-template-rows: repeat(7, ${CELL_PX}px);
  grid-auto-flow: column;
  grid-auto-columns: ${CELL_PX}px;
  gap: ${GAP_PX}px;
  /* 8 * 14 + 7 * 3 = 133px — fits any StreakCard width. */
  width: max-content;
  align-self: flex-end;
`;

const Cell = styled.div<{ $bg: string; $today: boolean; $hidden: boolean }>`
  width: ${CELL_PX}px;
  height: ${CELL_PX}px;
  border-radius: 2px;
  background: ${(p) => p.$bg};
  border: 1px solid ${(p) => (p.$today ? "var(--color-text, #333)" : "transparent")};
  visibility: ${(p) => (p.$hidden ? "hidden" : "visible")};
`;

const Legend = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  justify-content: flex-end;
`;

const LegendCell = styled.span<{ $bg: string }>`
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 2px;
  background: ${(p) => p.$bg};
`;

interface SessionStreakGridProps {
  entries: LifeEvent[];
  /** User's IANA tz — buckets day identity to match the rest of the app. */
  tz: string;
}

export function SessionStreakGrid({ entries, tz }: SessionStreakGridProps) {
  // The calendar grid (oldest week first, current week last) IS the layout: a
  // flat Su..Sa cell list whose day identity is tz-aware. We render it
  // column-major (grid-auto-flow: column) so each calendar week becomes a
  // visual column. `future` cells render hidden so the grid stays rectangular
  // and today lands at its real weekday row.
  const cells = useMemo(() => {
    // Dual-shape: a day "has" view V iff ANY run of V falls on it — whether the
    // run is a single fat `*_session` event or N per-item events. Normalize once
    // and bucket each run's local day by its view.
    const byView: Record<SessionView, Set<string>> = {
      morning: new Set(),
      evening: new Set(),
      weekly: new Set(),
    };
    for (const run of normalizeSessionRuns(entries)) {
      byView[run.view].add(dayKey(run.timestamp, tz));
    }
    const morningByDay = byView.morning;
    const eveningByDay = byView.evening;
    const weeklyByDay = byView.weekly;

    // buildCalendarGrid returns rows of weeks; flatten in week-then-day order so
    // the column-major grid lays weeks out as columns.
    return buildCalendarGrid(new Date(), WEEKS, tz).flat().map((cell) => ({
      key: cell.key,
      isToday: cell.isToday,
      future: cell.future,
      // Sunday = day-of-week index 0 within each 7-cell week row.
      isSun: dayjs(cell.date).day() === 0,
      morning: morningByDay.has(cell.key),
      evening: eveningByDay.has(cell.key),
      weekly: weeklyByDay.has(cell.key),
      labelDate: dayjs(cell.date).format("ddd, MMM D, YYYY"),
    }));
  }, [entries, tz]);

  return (
    <Wrap>
      <Grid>
        {cells.map((c) => {
          if (c.future) {
            return (
              <Cell
                key={c.key}
                $bg={splitBg(MUTED_COLOR, MUTED_COLOR)}
                $today={false}
                $hidden
              />
            );
          }
          // On Sundays the bottom-right triangle represents weekly_review
          // (purple), not evening — they subsume each other on Sundays.
          const topColor = c.morning ? LOGGED_COLOR : MUTED_COLOR;
          const bottomColor = c.isSun
            ? (c.weekly ? WEEKLY_COLOR : MUTED_COLOR)
            : (c.evening ? LOGGED_COLOR : MUTED_COLOR);
          const secondLabel = c.isSun ? "weekly review" : "evening";
          const secondDone = c.isSun ? c.weekly : c.evening;
          let tip: string;
          if (c.morning && secondDone) tip = `${c.labelDate} — morning + ${secondLabel}`;
          else if (c.morning) tip = `${c.labelDate} — morning only`;
          else if (secondDone) tip = `${c.labelDate} — ${secondLabel} only`;
          else tip = `${c.labelDate} — nothing logged`;
          return (
            <Tooltip key={c.key} title={tip} mouseEnterDelay={0.1}>
              <Cell
                $bg={splitBg(topColor, bottomColor)}
                $today={c.isToday}
                $hidden={false}
              />
            </Tooltip>
          );
        })}
      </Grid>
      <Legend>
        <LegendCell $bg={splitBg(LOGGED_COLOR, MUTED_COLOR)} />
        <span>morning</span>
        <LegendCell $bg={splitBg(MUTED_COLOR, LOGGED_COLOR)} />
        <span>evening</span>
        <LegendCell $bg={splitBg(MUTED_COLOR, WEEKLY_COLOR)} />
        <span>weekly</span>
      </Legend>
    </Wrap>
  );
}
