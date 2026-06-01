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
 * Also exports `computeStreaks` + the `SessionStreaks` shape, which the
 * dashboard uses to render the streak counters above the grid.
 */
import { useMemo } from "react";
import styled from "styled-components";
import { Tooltip } from "antd";
import dayjs from "dayjs";
import { sessionSubjectId, type Session } from "../manifest";
import type { LogEntry } from "../types";

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

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

interface DayData {
  /** Local YYYY-MM-DD */
  key: string;
  date: Date;
  morning: boolean;
  evening: boolean;
  /** Sundays only — was a weekly_review logged that day? */
  weekly: boolean;
}

interface SessionStreakGridProps {
  entries: LogEntry[];
}

export function SessionStreakGrid({ entries }: SessionStreakGridProps) {
  const morningSubject = sessionSubjectId("morning");
  const eveningSubject = sessionSubjectId("evening");
  const weeklySubject = sessionSubjectId("weekly_review");

  // Build a rectangular 8-week × 7-day window ending on the Saturday of the
  // current week. Days past today are rendered as hidden cells so the grid
  // stays rectangular and "today" lands at its actual weekday row.
  const cells = useMemo<DayData[]>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const morningByDay = new Set<string>();
    const eveningByDay = new Set<string>();
    const weeklyByDay = new Set<string>();
    for (const e of entries) {
      if (e.subjectId === morningSubject) morningByDay.add(dateKey(e.timestamp));
      else if (e.subjectId === eveningSubject) eveningByDay.add(dateKey(e.timestamp));
      else if (e.subjectId === weeklySubject) weeklyByDay.add(dateKey(e.timestamp));
    }

    const endDate = new Date(today);
    const daysToSat = 6 - endDate.getDay(); // Sun=0..Sat=6
    endDate.setDate(endDate.getDate() + daysToSat);

    const days: DayData[] = [];
    const totalDays = WEEKS * 7;
    for (let i = totalDays - 1; i >= 0; i--) {
      const d = new Date(endDate);
      d.setDate(d.getDate() - i);
      const k = dateKey(d);
      days.push({
        key: k,
        date: d,
        morning: morningByDay.has(k),
        evening: eveningByDay.has(k),
        weekly: weeklyByDay.has(k),
      });
    }
    return days;
  }, [entries, morningSubject, eveningSubject, weeklySubject]);

  const todayKey = dateKey(new Date());

  return (
    <Wrap>
      <Grid>
        {cells.map((c) => {
          const inFuture = c.date.getTime() > Date.now();
          if (inFuture) {
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
          const isSun = c.date.getDay() === 0;
          const topColor = c.morning ? LOGGED_COLOR : MUTED_COLOR;
          const bottomColor = isSun
            ? (c.weekly ? WEEKLY_COLOR : MUTED_COLOR)
            : (c.evening ? LOGGED_COLOR : MUTED_COLOR);
          const labelDate = dayjs(c.date).format("ddd, MMM D, YYYY");
          const secondLabel = isSun ? "weekly review" : "evening";
          const secondDone = isSun ? c.weekly : c.evening;
          let tip: string;
          if (c.morning && secondDone) tip = `${labelDate} — morning + ${secondLabel}`;
          else if (c.morning) tip = `${labelDate} — morning only`;
          else if (secondDone) tip = `${labelDate} — ${secondLabel} only`;
          else tip = `${labelDate} — nothing logged`;
          return (
            <Tooltip key={c.key} title={tip} mouseEnterDelay={0.1}>
              <Cell
                $bg={splitBg(topColor, bottomColor)}
                $today={c.key === todayKey}
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

// ---------------------------------------------------------------------------
// Streak utilities (exported for testing in the future + dashboard use)
// ---------------------------------------------------------------------------

export interface SessionStreaks {
  current: number;
  longest: number;
}

/**
 * Compute current + longest streaks of consecutive days with at least one
 * entry whose subject_id matches `sessionId`'s subject.
 *
 * "Current" doesn't break when today hasn't been logged yet — if today is
 * empty but yesterday is logged, the streak counts up to yesterday. This is
 * the convention requested in the spec ("today doesn't break the streak if
 * it hasn't started yet").
 */
export function computeStreaks(entries: LogEntry[], sessionId: Session["id"]): SessionStreaks {
  const subject = sessionSubjectId(sessionId);

  // Collect days that have at least one matching entry.
  const days = new Set<string>();
  for (const e of entries) {
    if (e.subjectId === subject) {
      days.add(dateKey(e.timestamp));
    }
  }
  if (days.size === 0) return { current: 0, longest: 0 };

  // Longest streak: walk sorted unique days, count runs of consecutive dates.
  const sorted = Array.from(days).sort(); // YYYY-MM-DD sorts lexically = chronologically.
  let longest = 1;
  let runLen = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + "T00:00:00");
    const curr = new Date(sorted[i] + "T00:00:00");
    const diffDays = Math.round((curr.getTime() - prev.getTime()) / 86_400_000);
    if (diffDays === 1) {
      runLen++;
      if (runLen > longest) longest = runLen;
    } else {
      runLen = 1;
    }
  }

  // Current: start at today, count backwards. If today missing, allow one
  // skip (only at the start) — start at yesterday instead.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let cursor = new Date(today);
  if (!days.has(dateKey(cursor))) {
    // Today not logged — try yesterday. If yesterday also not logged, current
    // streak is 0.
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(dateKey(cursor))) {
      return { current: 0, longest };
    }
  }
  let current = 0;
  while (days.has(dateKey(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}
