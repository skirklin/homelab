import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
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
import { useLife } from "../life-context";
import type { Widget, LogEntry } from "../types";

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

const WidgetSelect = styled(Select)`
  min-width: 200px;
`;

// Calendar Heat Map Styles
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

  &:hover {
    background: var(--color-bg-muted);
  }
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

// Stats Styles
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
  values: number[];
}

function getMonthData(entries: LogEntry[], widgetId: string, year: number, month: number): DayData[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const data: DayData[] = [];

  // Add empty cells for days before the first of the month
  for (let i = 0; i < firstDay.getDay(); i++) {
    data.push({ date: new Date(year, month, -firstDay.getDay() + i + 1), count: -1, values: [] });
  }

  // Add each day of the month
  for (let day = 1; day <= lastDay.getDate(); day++) {
    const date = new Date(year, month, day);
    const dayStart = new Date(year, month, day, 0, 0, 0, 0);
    const dayEnd = new Date(year, month, day, 23, 59, 59, 999);

    const dayEntries = entries.filter(
      (e) => e.subjectId === widgetId && e.timestamp >= dayStart && e.timestamp <= dayEnd
    );

    const values: number[] = [];
    dayEntries.forEach((e) => {
      if (typeof e.data.value === "number") values.push(e.data.value);
      if (typeof e.data.rating === "number") values.push(e.data.rating);
      if (typeof e.data.count === "number") values.push(e.data.count);
    });

    data.push({ date, count: dayEntries.length, values });
  }

  return data;
}

function getLast30DaysData(entries: LogEntry[], widgetId: string): { date: string; value: number; count: number }[] {
  const data: { date: string; value: number; count: number }[] = [];
  const today = new Date();

  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const dayEntries = entries.filter(
      (e) => e.subjectId === widgetId && e.timestamp >= date && e.timestamp <= dayEnd
    );

    const values: number[] = [];
    dayEntries.forEach((e) => {
      if (typeof e.data.value === "number") values.push(e.data.value);
      if (typeof e.data.rating === "number") values.push(e.data.rating);
    });

    const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    data.push({
      date: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: Math.round(avg * 10) / 10,
      count: dayEntries.length,
    });
  }

  return data;
}

function getWeeklyData(entries: LogEntry[], widgetId: string): { week: string; total: number; avg: number }[] {
  const data: { week: string; total: number; avg: number }[] = [];
  const today = new Date();

  for (let w = 11; w >= 0; w--) {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - (w * 7 + today.getDay()));
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const weekEntries = entries.filter(
      (e) => e.subjectId === widgetId && e.timestamp >= weekStart && e.timestamp <= weekEnd
    );

    const values: number[] = [];
    weekEntries.forEach((e) => {
      if (typeof e.data.value === "number") values.push(e.data.value);
      if (typeof e.data.rating === "number") values.push(e.data.rating);
      if (typeof e.data.count === "number") values.push(1);
    });

    const total = weekEntries.length;
    const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

    data.push({
      week: weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      total,
      avg: Math.round(avg * 10) / 10,
    });
  }

  return data;
}

function CalendarHeatMap({
  entries,
  widgetId,
}: {
  entries: LogEntry[];
  widgetId: string;
  widget: Widget;
}) {
  const [viewDate, setViewDate] = useState(new Date());
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const monthData = useMemo(() => getMonthData(entries, widgetId, year, month), [entries, widgetId, year, month]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const maxCount = Math.max(...monthData.filter((d) => d.count >= 0).map((d) => d.count), 1);

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));

  const monthName = viewDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  // Calculate stats
  const validDays = monthData.filter((d) => d.count >= 0);
  const totalCount = validDays.reduce((sum, d) => sum + d.count, 0);
  const daysWithActivity = validDays.filter((d) => d.count > 0).length;

  // Calculate streak (from today backwards)
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
          <StatValue>{totalCount}</StatValue>
          <StatLabel>Total this month</StatLabel>
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
        <NavButton onClick={prevMonth}>
          <LeftOutlined />
        </NavButton>
        <MonthLabel>{monthName}</MonthLabel>
        <NavButton onClick={nextMonth}>
          <RightOutlined />
        </NavButton>
      </MonthNav>

      <CalendarGrid>
        {DAYS.map((day) => (
          <DayLabel key={day}>{day}</DayLabel>
        ))}
        {monthData.map((day, i) => {
          const isToday = day.date.toDateString() === today.toDateString();
          const isEmpty = day.count < 0;
          const intensity = isEmpty ? 0 : Math.ceil((day.count / maxCount) * 4);
          const tooltip = isEmpty
            ? ""
            : `${day.date.toLocaleDateString()}: ${day.count} ${day.count === 1 ? "entry" : "entries"}`;

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

function TrendChart({
  entries,
  widgetId,
  widget,
}: {
  entries: LogEntry[];
  widgetId: string;
  widget: Widget;
}) {
  const data = useMemo(() => getLast30DaysData(entries, widgetId), [entries, widgetId]);

  // Calculate stats
  const values = data.filter((d) => d.value > 0).map((d) => d.value);
  const avgValue = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const daysWithData = values.length;
  const maxVal = Math.max(...values, 0);

  // Determine if this is a counter (show bar) or value (show line)
  const isCounter = widget.type === "counter";

  return (
    <>
      <StatsGrid>
        <StatCard>
          <StatValue>{avgValue.toFixed(1)}</StatValue>
          <StatLabel>30-day average</StatLabel>
        </StatCard>
        <StatCard>
          <StatValue>{daysWithData}</StatValue>
          <StatLabel>Days with data</StatLabel>
        </StatCard>
        <StatCard>
          <StatValue>{maxVal.toFixed(1)}</StatValue>
          <StatLabel>Peak value</StatLabel>
        </StatCard>
      </StatsGrid>

      <ChartContainer>
        <ResponsiveContainer width="100%" height="100%">
          {isCounter ? (
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
                tickFormatter={(v, i) => (i % 5 === 0 ? v : "")}
              />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip
                contentStyle={{
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                }}
              />
              <Bar dataKey="count" fill="#7c3aed" radius={[2, 2, 0, 0]} />
            </BarChart>
          ) : (
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
                tickFormatter={(v, i) => (i % 5 === 0 ? v : "")}
              />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip
                contentStyle={{
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="#7c3aed"
                fill="rgba(124, 58, 237, 0.2)"
                strokeWidth={2}
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </ChartContainer>
    </>
  );
}

function WeeklyChart({
  entries,
  widgetId,
  widget,
}: {
  entries: LogEntry[];
  widgetId: string;
  widget: Widget;
}) {
  const data = useMemo(() => getWeeklyData(entries, widgetId), [entries, widgetId]);

  const isCounter = widget.type === "counter";
  const dataKey = isCounter ? "total" : "avg";

  return (
    <ChartContainer>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="week" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} />
          <Tooltip
            contentStyle={{
              background: "var(--color-bg)",
              border: "1px solid var(--color-border)",
              borderRadius: "8px",
            }}
          />
          <Bar dataKey={dataKey} fill="#7c3aed" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}

export function Visualizations() {
  const { state } = useLife();
  const navigate = useNavigate();
  const [selectedWidget, setSelectedWidget] = useState<string | null>(null);

  const widgets = state.log?.manifest.widgets || [];
  const entries = Array.from(state.entries.values());

  // Auto-select first widget
  const widgetId = selectedWidget || widgets[0]?.id;
  const widget = widgets.find((w) => w.id === widgetId);

  if (widgets.length === 0) {
    return (
      <Container>
        <Header>
          <BackButton type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("..")} />
          <Title>Insights</Title>
        </Header>
        <Empty description="No widgets configured yet" />
      </Container>
    );
  }

  const widgetOptions = widgets.map((w) => ({
    value: w.id,
    label: w.label,
  }));

  const tabItems = [
    {
      key: "trend",
      label: "Daily Trend",
      children: widget && (
        <TrendChart entries={entries} widgetId={widgetId} widget={widget} />
      ),
    },
    {
      key: "weekly",
      label: "Weekly",
      children: widget && (
        <WeeklyChart entries={entries} widgetId={widgetId} widget={widget} />
      ),
    },
    {
      key: "calendar",
      label: "Calendar",
      children: widget && (
        <CalendarHeatMap entries={entries} widgetId={widgetId} widget={widget} />
      ),
    },
  ];

  return (
    <Container>
      <Header>
        <BackButton type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("..")} />
        <Title>Insights</Title>
        <WidgetSelect
          value={widgetId}
          onChange={(value) => setSelectedWidget(value as string)}
          options={widgetOptions}
        />
      </Header>

      <Tabs items={tabItems} />
    </Container>
  );
}
