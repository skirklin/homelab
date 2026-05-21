/**
 * GitHub-contributions-style year heatmap for life session entries.
 *
 * 53 weeks × 7 days, columns = weeks (oldest → newest left → right), rows =
 * day-of-week (Sun on top). Intensity per day = (morning_session ? 1 : 0) +
 * (evening_session ? 1 : 0) ∈ {0, 1, 2}.
 *
 * Pure CSS grid; no chart library. Tooltip via the antd Tooltip wrapping each
 * cell — light on the DOM since 53*7 = 371 elements is fine.
 */
import { useMemo } from "react";
import styled from "styled-components";
import { Tooltip } from "antd";
import dayjs from "dayjs";
import { sessionSubjectId, type Session } from "../manifest";
import type { LogEntry } from "../types";

const WEEKS = 53;

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
`;

const Grid = styled.div`
  display: grid;
  grid-template-rows: repeat(7, 12px);
  grid-auto-flow: column;
  grid-auto-columns: 12px;
  gap: 3px;
  /* Soft overflow on narrow screens — the grid is wider than mobile. */
  overflow-x: auto;
  padding-bottom: 2px;
`;

const Cell = styled.div<{ $level: 0 | 1 | 2; $today: boolean }>`
  width: 12px;
  height: 12px;
  border-radius: 2px;
  background: ${(p) =>
    p.$level === 2
      ? "#13c2c2"
      : p.$level === 1
        ? "rgba(19, 194, 194, 0.45)"
        : "var(--color-bg-muted, #f0f0f0)"};
  border: 1px solid ${(p) => (p.$today ? "var(--color-text, #333)" : "transparent")};
  cursor: ${(p) => (p.$level > 0 ? "default" : "default")};
`;

const Legend = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  justify-content: flex-end;
`;

const LegendCell = styled.span<{ $level: 0 | 1 | 2 }>`
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: ${(p) =>
    p.$level === 2
      ? "#13c2c2"
      : p.$level === 1
        ? "rgba(19, 194, 194, 0.45)"
        : "var(--color-bg-muted, #f0f0f0)"};
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
}

interface YearHeatmapProps {
  entries: LogEntry[];
}

export function YearHeatmap({ entries }: YearHeatmapProps) {
  const morningSubject = sessionSubjectId("morning");
  const eveningSubject = sessionSubjectId("evening");

  // Walk back from today to the same weekday WEEKS weeks ago so the rightmost
  // column ends on today. Then pad the start back to Sunday so columns are
  // proper weeks (Sun→Sat).
  const cells = useMemo<DayData[]>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Index entries by date for O(1) lookup.
    const morningByDay = new Set<string>();
    const eveningByDay = new Set<string>();
    for (const e of entries) {
      if (e.subjectId === morningSubject) morningByDay.add(dateKey(e.timestamp));
      else if (e.subjectId === eveningSubject) eveningByDay.add(dateKey(e.timestamp));
    }

    // End at end-of-current-week (Saturday) so the grid is rectangular.
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
      });
    }
    return days;
  }, [entries, morningSubject, eveningSubject]);

  const todayKey = dateKey(new Date());

  return (
    <Wrap>
      <Grid>
        {cells.map((c) => {
          const inFuture = c.date.getTime() > Date.now();
          const level: 0 | 1 | 2 = (c.morning ? 1 : 0) + (c.evening ? 1 : 0) as 0 | 1 | 2;
          if (inFuture) {
            return <Cell key={c.key} $level={0} $today={false} style={{ visibility: "hidden" }} />;
          }
          const labelDate = dayjs(c.date).format("ddd, MMM D, YYYY");
          const sessions: string[] = [];
          if (c.morning) sessions.push("morning");
          if (c.evening) sessions.push("evening");
          const tip =
            sessions.length === 0
              ? `${labelDate} — nothing logged`
              : `${labelDate} — ${sessions.join(" + ")}`;
          return (
            <Tooltip key={c.key} title={tip} mouseEnterDelay={0.1}>
              <Cell $level={level} $today={c.key === todayKey} />
            </Tooltip>
          );
        })}
      </Grid>
      <Legend>
        <span>Less</span>
        <LegendCell $level={0} />
        <LegendCell $level={1} />
        <LegendCell $level={2} />
        <span>More</span>
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
