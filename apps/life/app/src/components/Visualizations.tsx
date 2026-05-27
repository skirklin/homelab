import { useMemo, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import styled from "styled-components";
import { Select, Empty, Tabs, Button } from "antd";
import { LeftOutlined, RightOutlined, ArrowLeftOutlined } from "@ant-design/icons";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import { useLifeContext } from "../life-context";
import { TRACKABLES, type Trackable } from "../manifest";
import type { LogEntry } from "../types";
import { aggregationFor, primaryEntryName } from "../lib/format";

const Container = styled.div`
  max-width: 800px;
  margin: 0 auto;
  padding: var(--space-md);
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-md);
  margin-bottom: var(--space-lg);
  flex-wrap: wrap;
`;

const BackButton = styled(Button)`
  padding: 0;
`;

const Title = styled.h1`
  font-size: var(--font-size-xl);
  margin: 0;
  color: var(--color-text);
  flex: 1;
`;

const TrackableSelect = styled(Select)`
  min-width: 220px;
`;

// --- Calendar heatmap ---

const CalendarContainer = styled.div`
  overflow-x: auto;
  padding: var(--space-sm) 0;
`;

const MonthNav = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
`;

const NavButton = styled.button`
  background: none;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: var(--space-xs) var(--space-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  color: var(--color-text);

  &:hover { background: var(--color-bg-muted); }
`;

const MonthLabel = styled.span`
  font-weight: 500;
  min-width: 150px;
  text-align: center;
`;

const CalendarGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 3px;
  max-width: 350px;
  margin: 0 auto;
`;

const DayLabel = styled.div`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  text-align: center;
  padding: var(--space-xs);
`;

const DayCell = styled.div<{ $intensity: number; $isToday: boolean; $isEmpty: boolean }>`
  aspect-ratio: 1;
  border-radius: var(--radius-sm);
  background: ${(props) => {
    if (props.$isEmpty) return "transparent";
    if (props.$intensity === 0) return "var(--color-bg-muted)";
    const opacity = Math.min(0.2 + props.$intensity * 0.2, 1);
    return `rgba(124, 58, 237, ${opacity})`;
  }};
  border: ${(props) => (props.$isToday ? "2px solid var(--color-primary)" : "none")};
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-xs);
  color: ${(props) => (props.$intensity >= 3 ? "white" : "var(--color-text)")};
  cursor: ${(props) => (props.$isEmpty ? "default" : "pointer")};
  position: relative;

  &:hover::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    background: var(--color-text);
    color: var(--color-bg);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    white-space: nowrap;
    z-index: 10;
    pointer-events: none;
  }
`;

const StatsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-md);
  margin-bottom: var(--space-lg);
`;

const StatCard = styled.div`
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  text-align: center;
`;

const StatValue = styled.div`
  font-size: var(--font-size-xl);
  font-weight: 600;
  color: var(--color-primary);
`;

const StatLabel = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`;

const ChartContainer = styled.div`
  height: 300px;
  margin: var(--space-lg) 0;
`;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface DayData {
  date: Date;
  count: number;
  /** Aggregated value (per the trackable's aggregation) for the day. */
  value: number;
}

/**
 * Collect the primary numeric values for a trackable from a set of events.
 * `primaryEntryName(trackableId)` tells us which entry name carries the
 * trackable's main number; we pull every matching value across events.
 */
function collectValues(events: LogEntry[], trackableId: string): number[] {
  const name = primaryEntryName(trackableId);
  const out: number[] = [];
  for (const ev of events) {
    if (ev.subjectId !== trackableId) continue;
    for (const entry of ev.entries) {
      if (entry.type === "number" && entry.name === name) out.push(entry.value);
    }
  }
  return out;
}

/** Aggregate a list of values per the unit's policy. */
function aggregateValues(values: number[], unit: string): number {
  if (values.length === 0) return 0;
  if (aggregationFor(unit) === "avg") {
    return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
  }
  return values.reduce((a, b) => a + b, 0);
}

function getMonthData(entries: LogEntry[], trackable: Trackable, year: number, month: number): DayData[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const data: DayData[] = [];

  for (let i = 0; i < firstDay.getDay(); i++) {
    data.push({ date: new Date(year, month, -firstDay.getDay() + i + 1), count: -1, value: 0 });
  }

  for (let day = 1; day <= lastDay.getDate(); day++) {
    const date = new Date(year, month, day);
    const dayStart = new Date(year, month, day, 0, 0, 0, 0);
    const dayEnd = new Date(year, month, day, 23, 59, 59, 999);

    const dayEvents = entries.filter(
      (e) => e.subjectId === trackable.id && e.timestamp >= dayStart && e.timestamp <= dayEnd,
    );
    data.push({
      date,
      count: dayEvents.length,
      value: aggregateValues(collectValues(dayEvents, trackable.id), trackable.unit),
    });
  }
  return data;
}

function getLast30DaysData(entries: LogEntry[], trackable: Trackable): { date: string; value: number; count: number }[] {
  const data: { date: string; value: number; count: number }[] = [];
  const today = new Date();

  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const dayEvents = entries.filter(
      (e) => e.subjectId === trackable.id && e.timestamp >= date && e.timestamp <= dayEnd,
    );
    data.push({
      date: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: aggregateValues(collectValues(dayEvents, trackable.id), trackable.unit),
      count: dayEvents.length,
    });
  }
  return data;
}

function getWeeklyData(entries: LogEntry[], trackable: Trackable): { week: string; value: number; count: number }[] {
  const data: { week: string; value: number; count: number }[] = [];
  const today = new Date();

  for (let w = 11; w >= 0; w--) {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - (w * 7 + today.getDay()));
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const weekEvents = entries.filter(
      (e) => e.subjectId === trackable.id && e.timestamp >= weekStart && e.timestamp <= weekEnd,
    );

    data.push({
      week: weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: aggregateValues(collectValues(weekEvents, trackable.id), trackable.unit),
      count: weekEvents.length,
    });
  }
  return data;
}

function CalendarHeatMap({
  entries,
  trackable,
  viewDate,
  onMonthChange,
}: {
  entries: LogEntry[];
  trackable: Trackable;
  viewDate: Date;
  onMonthChange: (date: Date) => void;
}) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const monthData = useMemo(
    () => getMonthData(entries, trackable, year, month),
    [entries, trackable, year, month],
  );
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const maxCount = Math.max(...monthData.filter((d) => d.count >= 0).map((d) => d.count), 1);

  const prevMonth = () => onMonthChange(new Date(year, month - 1, 1));
  const nextMonth = () => onMonthChange(new Date(year, month + 1, 1));
  const monthName = viewDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const validDays = monthData.filter((d) => d.count >= 0);
  const totalValue = validDays.reduce((sum, d) => sum + d.value, 0);
  const daysWithActivity = validDays.filter((d) => d.count > 0).length;
  const isAvg = aggregationFor(trackable.unit) === "avg";

  let currentStreak = 0;
  const todayIndex = validDays.findIndex((d) => d.date.toDateString() === today.toDateString());
  if (todayIndex >= 0) {
    for (let i = todayIndex; i >= 0; i--) {
      if (validDays[i].count > 0) currentStreak++;
      else break;
    }
  }

  return (
    <CalendarContainer>
      <StatsGrid>
        <StatCard>
          <StatValue>{isAvg ? (totalValue / Math.max(daysWithActivity, 1)).toFixed(1) : totalValue}</StatValue>
          <StatLabel>{isAvg ? "Monthly avg" : `Monthly total (${trackable.unit})`}</StatLabel>
        </StatCard>
        <StatCard>
          <StatValue>{daysWithActivity}</StatValue>
          <StatLabel>Active days</StatLabel>
        </StatCard>
        <StatCard>
          <StatValue>{currentStreak}</StatValue>
          <StatLabel>Current streak</StatLabel>
        </StatCard>
      </StatsGrid>

      <MonthNav>
        <NavButton onClick={prevMonth}><LeftOutlined /></NavButton>
        <MonthLabel>{monthName}</MonthLabel>
        <NavButton onClick={nextMonth}><RightOutlined /></NavButton>
      </MonthNav>

      <CalendarGrid>
        {DAYS.map((day) => <DayLabel key={day}>{day}</DayLabel>)}
        {monthData.map((day, i) => {
          const isToday = day.date.toDateString() === today.toDateString();
          const isEmpty = day.count < 0;
          const intensity = isEmpty ? 0 : Math.ceil((day.count / maxCount) * 4);
          const tooltip = isEmpty
            ? ""
            : `${day.date.toLocaleDateString()}: ${day.value} ${trackable.unit} (${day.count})`;
          return (
            <DayCell
              key={i}
              $intensity={intensity}
              $isToday={isToday}
              $isEmpty={isEmpty}
              data-tooltip={tooltip}
            >
              {!isEmpty && day.date.getDate()}
            </DayCell>
          );
        })}
      </CalendarGrid>
    </CalendarContainer>
  );
}

function TrendChart({ entries, trackable }: { entries: LogEntry[]; trackable: Trackable }) {
  const data = useMemo(
    () => getLast30DaysData(entries, trackable),
    [entries, trackable],
  );

  const nonZero = data.filter((d) => d.value > 0).map((d) => d.value);
  const avgValue = nonZero.length > 0 ? nonZero.reduce((a, b) => a + b, 0) / nonZero.length : 0;
  const daysWithData = nonZero.length;
  const maxVal = Math.max(...nonZero, 0);

  // Chart shape per aggregation: sum→bar, avg→area.
  const ChartTag = aggregationFor(trackable.unit) === "sum" ? "bar" : "area";

  return (
    <>
      <StatsGrid>
        <StatCard>
          <StatValue>{avgValue.toFixed(1)}</StatValue>
          <StatLabel>30-day avg ({trackable.unit})</StatLabel>
        </StatCard>
        <StatCard>
          <StatValue>{daysWithData}</StatValue>
          <StatLabel>Days with data</StatLabel>
        </StatCard>
        <StatCard>
          <StatValue>{maxVal.toFixed(1)}</StatValue>
          <StatLabel>Peak</StatLabel>
        </StatCard>
      </StatsGrid>

      <ChartContainer>
        <ResponsiveContainer width="100%" height="100%">
          {ChartTag === "bar" ? (
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" tickFormatter={(v, i) => (i % 5 === 0 ? v : "")} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "8px" }} />
              <Bar dataKey="value" fill="#7c3aed" radius={[2, 2, 0, 0]} />
            </BarChart>
          ) : (
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" tickFormatter={(v, i) => (i % 5 === 0 ? v : "")} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "8px" }} />
              <Area type="monotone" dataKey="value" stroke="#7c3aed" fill="rgba(124, 58, 237, 0.2)" strokeWidth={2} />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </ChartContainer>
    </>
  );
}

function WeeklyChart({ entries, trackable }: { entries: LogEntry[]; trackable: Trackable }) {
  const data = useMemo(
    () => getWeeklyData(entries, trackable),
    [entries, trackable],
  );

  return (
    <ChartContainer>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="week" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} />
          <Tooltip contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "8px" }} />
          <Bar dataKey="value" fill="#7c3aed" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}

// `?month=YYYY-MM` → first day of that month in local time. Invalid input
// falls back to "this month" so URLs from elsewhere don't crash the view.
const MONTH_RE = /^(\d{4})-(\d{2})$/;
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function parseMonthParam(raw: string | null): Date {
  if (!raw) return startOfMonth(new Date());
  const m = MONTH_RE.exec(raw);
  if (!m) return startOfMonth(new Date());
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 2000 || year > 9999 || month < 1 || month > 12) {
    return startOfMonth(new Date());
  }
  return new Date(year, month - 1, 1, 0, 0, 0, 0);
}
function formatMonthParam(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
function isCurrentMonth(d: Date): boolean {
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

export function Visualizations() {
  const { state } = useLifeContext();
  const navigate = useNavigate();
  // Both the selected trackable and the calendar month live in the URL so
  // refresh + share-link round-trip the exact view. Defaults (first trackable,
  // current month) aren't written to keep the URL clean.
  const [searchParams, setSearchParams] = useSearchParams();
  const trackableParam = searchParams.get("trackable");
  const selectedId = trackableParam && TRACKABLES.some((t) => t.id === trackableParam)
    ? trackableParam
    : null;
  const viewDate = useMemo(() => parseMonthParam(searchParams.get("month")), [searchParams]);

  const setSelectedId = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          // First trackable is the default; don't write it.
          if (!next || next === TRACKABLES[0]?.id) {
            params.delete("trackable");
          } else {
            params.set("trackable", next);
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setViewDate = useCallback(
    (next: Date) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (isCurrentMonth(next)) {
            params.delete("month");
          } else {
            params.set("month", formatMonthParam(next));
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Preserve any inherited `?date=YYYY-MM-DD` when navigating back to the
  // dashboard — mirrors Journal's behavior so a tab switch doesn't drop the
  // per-day context.
  const dateParam = searchParams.get("date");
  const dateQuerySuffix = dateParam ? `?date=${encodeURIComponent(dateParam)}` : "";

  // Unified shape — read entries directly. No more normalization adapter; the
  // 20260522 migration rewrote every legacy row in place.
  const allEntries: LogEntry[] = useMemo(() => Array.from(state.entries.values()), [state.entries]);

  const currentId = selectedId || TRACKABLES[0]?.id;
  const trackable = TRACKABLES.find((t) => t.id === currentId);

  if (!trackable) {
    return (
      <Container>
        <Header>
          <BackButton type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(`..${dateQuerySuffix}`)} />
          <Title>Insights</Title>
        </Header>
        <Empty description="No trackables configured" />
      </Container>
    );
  }

  const options = TRACKABLES.map((t) => ({
    value: t.id,
    label: t.group ? `${t.group} › ${t.label}` : t.label,
  }));

  const tabItems = [
    {
      key: "trend",
      label: "Daily Trend",
      children: <TrendChart entries={allEntries} trackable={trackable} />,
    },
    {
      key: "weekly",
      label: "Weekly",
      children: <WeeklyChart entries={allEntries} trackable={trackable} />,
    },
    {
      key: "calendar",
      label: "Calendar",
      children: (
        <CalendarHeatMap
          entries={allEntries}
          trackable={trackable}
          viewDate={viewDate}
          onMonthChange={setViewDate}
        />
      ),
    },
  ];

  return (
    <Container>
      <Header>
        <BackButton type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(`..${dateQuerySuffix}`)} />
        <Title>Insights</Title>
        <TrackableSelect
          value={currentId}
          onChange={(value) => setSelectedId(value as string)}
          options={options}
        />
      </Header>

      <Tabs items={tabItems} />
    </Container>
  );
}
