/**
 * Per-habit history screen — a full-height bottom Drawer (mirroring ShapeSheet's
 * mount pattern) opened by tapping a habit's name on the HabitBoard. For the
 * tapped trackable (and its goal, if any) it shows:
 *   - a GitHub-style YearHeatmap (53 weeks, shared cell coloring),
 *   - per-year + per-month stat summaries (completion %),
 *   - the current month as a full grid, paginating lazily back through history.
 *
 * Every calendar surface here reuses the SAME tz-aware day index + cellState as
 * the board strips, and the SAME tap/long-press interactions (Part 1): a tap on
 * a `happened` cell toggles, a long press opens the editor; other shapes tap to
 * edit. The interactions are delegated up to HabitBoard via the callbacks so the
 * undo/backfill wiring stays in one place.
 */
import { useMemo, useState } from "react";
import styled from "styled-components";
import { Drawer } from "antd";
import type { LifeEvent, LifeManifestTrackable, LifeGoal } from "@homelab/backend";
import { startOfDay } from "@homelab/backend";
import type { DayIndex } from "../lib/dayIndex";
import { TrackerCalendar } from "./TrackerCalendar";
import { YearHeatmap } from "./YearHeatmap";
import {
  yearStats,
  monthStats,
  monthLabel,
  monthKey,
  prevMonth,
  type MonthStats,
} from "../lib/habitStats";

const HOUR_MS = 60 * 60 * 1000;

const Section = styled.div`
  margin-bottom: var(--space-lg);
`;

const SectionTitle = styled.div`
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary);
  margin-bottom: var(--space-sm);
`;

const StatGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-sm);
`;

const Stat = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
`;

const StatValue = styled.div`
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
`;

const StatLabel = styled.div`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
`;

const MonthBlock = styled.div`
  margin-bottom: var(--space-md);
`;

const MonthHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--space-xs);
`;

const MonthName = styled.div`
  font-weight: 600;
  color: var(--color-text);
`;

const MonthPct = styled.div`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
`;

const MoreButton = styled.button`
  width: 100%;
  background: none;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-sm);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;

  &:hover { color: var(--color-primary); border-color: var(--color-primary); }
`;

/** How many month grids to add each time "Show earlier" is tapped. */
const MONTH_PAGE = 3;

export interface HabitHistoryProps {
  open: boolean;
  thing: LifeManifestTrackable | null;
  goal: LifeGoal | null;
  index: DayIndex;
  events: LifeEvent[];
  tz: string;
  today: Date;
  onClose: () => void;
  onTapDay: (
    thing: LifeManifestTrackable,
    goal: LifeGoal | null,
    date: Date,
    events: LifeEvent[],
  ) => void;
  onLongPressDay: (
    thing: LifeManifestTrackable,
    goal: LifeGoal | null,
    date: Date,
    events: LifeEvent[],
  ) => void;
}

/** Weeks needed to cover a month plus a little slack, for the month grid. */
const MONTH_GRID_WEEKS = 6;

export function HabitHistory({
  open,
  thing,
  goal,
  index,
  events,
  tz,
  today,
  onClose,
  onTapDay,
  onLongPressDay,
}: HabitHistoryProps) {
  const subjectIds = useMemo(() => (thing ? [thing.id] : []), [thing]);

  // How many months back the user has revealed (1 = current month only).
  const [monthsShown, setMonthsShown] = useState(MONTH_PAGE);

  const year = useMemo(
    () => (thing ? yearStats(subjectIds, goal, index, events, tz, today) : null),
    [thing, subjectIds, goal, index, events, tz, today],
  );

  // Month refs: current month, then prevMonth() stepping back `monthsShown`.
  const monthRefs = useMemo(() => {
    if (!thing) return [];
    const refs: Date[] = [];
    let cursor = today;
    for (let i = 0; i < monthsShown; i++) {
      refs.push(cursor);
      cursor = prevMonth(cursor, tz);
    }
    return refs;
  }, [thing, monthsShown, today, tz]);

  const monthData = useMemo<{ ref: Date; stats: MonthStats }[]>(() => {
    if (!thing) return [];
    return monthRefs.map((ref) => ({
      ref,
      stats: monthStats(subjectIds, goal, index, events, tz, ref, today),
    }));
  }, [thing, monthRefs, subjectIds, goal, index, events, tz, today]);

  if (!thing) return null;

  const goalUndef = goal ?? undefined;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="bottom"
      height="92%"
      title={thing.label}
      destroyOnClose
      data-testid="habit-history"
      styles={{ body: { padding: "var(--space-md)" } }}
    >
      {/* Year totals */}
      {year && (
        <Section>
          <SectionTitle>This year</SectionTitle>
          <StatGrid data-testid="year-stats">
            <Stat>
              <StatValue data-testid="stat-completed">{year.completedDays}</StatValue>
              <StatLabel>completed days · {year.pct}%</StatLabel>
            </Stat>
            <Stat>
              <StatValue data-testid="stat-elapsed">{year.elapsedDays}</StatValue>
              <StatLabel>days tracked</StatLabel>
            </Stat>
          </StatGrid>
        </Section>
      )}

      {/* Year heatmap */}
      <Section>
        <SectionTitle>Past year</SectionTitle>
        <YearHeatmap
          subjectIds={subjectIds}
          goal={goalUndef}
          index={index}
          tz={tz}
          today={today}
          onTapDay={(date, evts) => onTapDay(thing, goal, date, evts)}
          onLongPressDay={(date, evts) => onLongPressDay(thing, goal, date, evts)}
        />
      </Section>

      {/* Month grids, newest first, lazily paginated */}
      <Section>
        <SectionTitle>By month</SectionTitle>
        {monthData.map(({ ref, stats }) => (
          <MonthBlock key={monthLabel(ref, tz)} data-testid="month-block">
            <MonthHeader>
              <MonthName>{monthLabel(ref, tz)}</MonthName>
              <MonthPct data-testid="month-pct">
                {stats.completed}/{stats.elapsed} · {stats.pct}%
              </MonthPct>
            </MonthHeader>
            <TrackerCalendar
              subjectIds={subjectIds}
              goal={goalUndef}
              weeks={MONTH_GRID_WEEKS}
              index={index}
              tz={tz}
              // Anchor each month grid on the LAST day of that month (clamped to
              // today for the current month) so the 6-week window covers it.
              today={monthAnchor(ref, today, tz)}
              onTapDay={(date, evts) => onTapDay(thing, goal, date, evts)}
              onLongPressDay={(date, evts) => onLongPressDay(thing, goal, date, evts)}
            />
          </MonthBlock>
        ))}
        <MoreButton onClick={() => setMonthsShown((n) => n + MONTH_PAGE)} data-testid="show-earlier">
          Show earlier months
        </MoreButton>
      </Section>
    </Drawer>
  );
}

/**
 * The TrackerCalendar always ends at the week containing its `today`. To show a
 * specific month, anchor on that month's last day — except the CURRENT month,
 * which anchors on the real today (so future days in this month stay inert and
 * the today marker shows). Past months anchor on their final day.
 */
function monthAnchor(monthRef: Date, today: Date, tz: string): Date {
  const refMonth = monthKey(monthRef, tz);
  if (refMonth === monthKey(today, tz)) return today;
  // Walk forward to the last day of monthRef's month: step day-by-day until the
  // month rolls over, then back one.
  let cursor = startOfDay(monthRef, tz);
  for (let i = 0; i < 40; i++) {
    const next = startOfDay(new Date(cursor.getTime() + 26 * HOUR_MS), tz);
    if (monthKey(next, tz) !== refMonth) break;
    cursor = next;
  }
  return new Date(cursor.getTime() + 12 * HOUR_MS); // local noon of the last day
}
