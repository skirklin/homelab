import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useUrlParam } from "@kirkl/shared";
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
import { useTrackables } from "../lib/trackables";
import type { LogEntry } from "../types";
import { aggregationFor } from "../lib/format";

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

const SeriesSelect = styled(Select)`
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

// --- Series model ----------------------------------------------------------
//
// A chartable series is a set of subjectIds: one THING (a vocab row, or an
// unknown subjectId found in history — degrade, don't drop), or a GROUP
// rollup over every vocab row sharing a `group` (walk/run/bike → "exercise").

interface Series {
  /** Select value. Things use their id; groups use `group:<name>`. */
  key: string;
  label: string;
  subjectIds: string[];
}

const GROUP_PREFIX = "group:";

function buildSeries(trackables: ReturnType<typeof useTrackables>, entries: LogEntry[]): Series[] {
  const out: Series[] = [];
  const known = new Set<string>();
  const byGroup = new Map<string, string[]>();

  for (const t of trackables) {
    known.add(t.id);
    out.push({ key: t.id, label: t.label, subjectIds: [t.id] });
    if (t.group) {
      const list = byGroup.get(t.group);
      if (list) list.push(t.id);
      else byGroup.set(t.group, [t.id]);
    }
  }

  // Group rollups — only when the rollup actually aggregates >1 thing.
  for (const [group, ids] of byGroup) {
    if (ids.length < 2) continue;
    out.push({ key: `${GROUP_PREFIX}${group}`, label: `${group} (all)`, subjectIds: ids });
  }

  // Unknown subjectIds in history (vocab row deleted): chart under the raw id.
  const unknown = new Set<string>();
  for (const e of entries) {
    if (!known.has(e.subjectId)) unknown.add(e.subjectId);
  }
  for (const id of [...unknown].sort()) {
    out.push({ key: id, label: id, subjectIds: [id] });
  }

  return out;
}

/**
 * The unit a series charts in, derived from its DATA (name-agnostic — history
 * predates the shape model): the first non-rating number unit seen, else
 * "rating" when only ratings exist, else "ct".
 */
function seriesUnit(entries: LogEntry[], subjectIds: Set<string>): string {
  let sawRating = false;
  for (const e of entries) {
    if (!subjectIds.has(e.subjectId)) continue;
    for (const entry of e.entries) {
      if (entry.type !== "number") continue;
      if (entry.unit === "rating") {
        sawRating = true;
        continue;
      }
      return entry.unit;
    }
  }
  return sawRating ? "rating" : "ct";
}

/** Every numeric value carrying `unit` across the given events. */
function collectUnitValues(events: LogEntry[], unit: string): number[] {
  const out: number[] = [];
  for (const ev of events) {
    for (const e of ev.entries) {
      if (e.type === "number" && e.unit === unit) out.push(e.value);
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

interface DayData {
  date: Date;
  count: number;
  /** Aggregated value (per the unit's aggregation) for the day. */
  value: number;
}

function eventsInRange(entries: LogEntry[], subjectIds: Set<string>, lo: Date, hi: Date): LogEntry[] {
  return entries.filter((e) => subjectIds.has(e.subjectId) && e.timestamp >= lo && e.timestamp <= hi);
}

function getMonthData(entries: LogEntry[], subjectIds: Set<string>, unit: string, year: number, month: number): DayData[] {
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
    const dayEvents = eventsInRange(entries, subjectIds, dayStart, dayEnd);
    data.push({
      date,
      count: dayEvents.length,
      value: aggregateValues(collectUnitValues(dayEvents, unit), unit),
    });
  }
  return data;
}

function getLast30DaysData(entries: LogEntry[], subjectIds: Set<string>, unit: string): { date: string; value: number; count: number }[] {
  const data: { date: string; value: number; count: number }[] = [];
  const today = new Date();

  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);
    const dayEvents = eventsInRange(entries, subjectIds, date, dayEnd);
    data.push({
      date: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: aggregateValues(collectUnitValues(dayEvents, unit), unit),
      count: dayEvents.length,
    });
  }
  return data;
}

function getWeeklyData(entries: LogEntry[], subjectIds: Set<string>, unit: string): { week: string; value: number; count: number }[] {
  const data: { week: string; value: number; count: number }[] = [];
  const today = new Date();

  for (let w = 11; w >= 0; w--) {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - (w * 7 + today.getDay()));
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const weekEvents = eventsInRange(entries, subjectIds, weekStart, weekEnd);
    data.push({
      week: weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: aggregateValues(collectUnitValues(weekEvents, unit), unit),
      count: weekEvents.length,
    });
  }
  return data;
}

function CalendarHeatMap({
  entries,
  subjectIds,
  unit,
  viewDate,
  onMonthChange,
}: {
  entries: LogEntry[];
  subjectIds: Set<string>;
  unit: string;
  viewDate: Date;
  onMonthChange: (date: Date) => void;
}) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const monthData = useMemo(
    () => getMonthData(entries, subjectIds, unit, year, month),
    [entries, subjectIds, unit, year, month],
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
  const isAvg = aggregationFor(unit) === "avg";

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
          <StatLabel>{isAvg ? "Monthly avg" : `Monthly total (${unit})`}</StatLabel>
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
            : `${day.date.toLocaleDateString()}: ${day.value} ${unit} (${day.count})`;
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

function TrendChart({ entries, subjectIds, unit }: { entries: LogEntry[]; subjectIds: Set<string>; unit: string }) {
  const data = useMemo(
    () => getLast30DaysData(entries, subjectIds, unit),
    [entries, subjectIds, unit],
  );

  const nonZero = data.filter((d) => d.value > 0).map((d) => d.value);
  const avgValue = nonZero.length > 0 ? nonZero.reduce((a, b) => a + b, 0) / nonZero.length : 0;
  const daysWithData = nonZero.length;
  const maxVal = Math.max(...nonZero, 0);

  // Chart shape per aggregation: sum→bar, avg→area.
  const ChartTag = aggregationFor(unit) === "sum" ? "bar" : "area";

  return (
    <>
      <StatsGrid>
        <StatCard>
          <StatValue>{avgValue.toFixed(1)}</StatValue>
          <StatLabel>30-day avg ({unit})</StatLabel>
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

function WeeklyChart({ entries, subjectIds, unit }: { entries: LogEntry[]; subjectIds: Set<string>; unit: string }) {
  const data = useMemo(
    () => getWeeklyData(entries, subjectIds, unit),
    [entries, subjectIds, unit],
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
  const trackables = useTrackables();
  // Both the selected series and the calendar month live in the URL so
  // refresh + share-link round-trip the exact view. Defaults (first series,
  // current month) aren't written to keep the URL clean. The raw param is kept
  // verbatim; membership is validated against the series list below.
  const [selectedKey, setSelectedKey] = useUrlParam<string | null>("trackable", {
    parse: (raw) => raw,
    serialize: (v) => v,
    default: null,
  });
  const [viewDate, setViewDate] = useUrlParam<Date>("month", {
    parse: parseMonthParam,
    serialize: (v) => (isCurrentMonth(v) ? null : formatMonthParam(v)),
    // Default-elision compares serialized strings; passing the current month
    // keeps `serialize(default)` === null so any new value compared via the
    // default-equality branch never spuriously deletes.
    default: parseMonthParam(null),
  });

  // Preserve any inherited `?date=YYYY-MM-DD` when navigating back to the
  // dashboard — mirrors Journal's behavior so a tab switch doesn't drop the
  // per-day context.
  const [dateParam] = useUrlParam<string | null>("date", {
    parse: (raw) => raw,
    serialize: (v) => v,
    default: null,
  });
  const dateQuerySuffix = dateParam ? `?date=${encodeURIComponent(dateParam)}` : "";

  const allEntries: LogEntry[] = useMemo(() => Array.from(state.entries.values()), [state.entries]);

  // Things (vocab rows + unknown history subjects) and group rollups.
  const series = useMemo(() => buildSeries(trackables, allEntries), [trackables, allEntries]);

  const selectedValid = selectedKey && series.some((s) => s.key === selectedKey) ? selectedKey : null;
  const currentKey = selectedValid || series[0]?.key;
  const current = series.find((s) => s.key === currentKey);

  const subjectIds = useMemo(() => new Set(current?.subjectIds ?? []), [current]);
  const unit = useMemo(() => seriesUnit(allEntries, subjectIds), [allEntries, subjectIds]);

  if (!current) {
    return (
      <Container>
        <Header>
          <BackButton type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(`..${dateQuerySuffix}`)} />
          <Title>Insights</Title>
        </Header>
        <Empty description="Nothing to chart yet" />
      </Container>
    );
  }

  const options = series.map((s) => ({ value: s.key, label: s.label }));

  const tabItems = [
    {
      key: "trend",
      label: "Daily Trend",
      children: <TrendChart entries={allEntries} subjectIds={subjectIds} unit={unit} />,
    },
    {
      key: "weekly",
      label: "Weekly",
      children: <WeeklyChart entries={allEntries} subjectIds={subjectIds} unit={unit} />,
    },
    {
      key: "calendar",
      label: "Calendar",
      children: (
        <CalendarHeatMap
          entries={allEntries}
          subjectIds={subjectIds}
          unit={unit}
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
        <SeriesSelect
          value={currentKey}
          onChange={(value) => setSelectedKey(value as string)}
          options={options}
          showSearch
          optionFilterProp="label"
        />
      </Header>

      <Tabs items={tabItems} />
    </Container>
  );
}
