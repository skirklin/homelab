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
import type { Widget, LogEntry, CounterGroupWidget as CounterGroupWidgetType, ComboWidget as ComboWidgetType, SampleQuestion } from "../types";

// Helper to extract numeric values from an entry based on widget type
// fieldId is used when extracting a specific field from combo entries
function extractNumericValues(entry: LogEntry, widget: Widget, fieldId?: string): number[] {
  const values: number[] = [];
  const data = entry.data;

  // If fieldId is specified, extract that specific field (for combo-derived items)
  if (fieldId) {
    const fieldValue = data[fieldId];
    if (typeof fieldValue === "number") {
      values.push(fieldValue);
    }
    return values;
  }

  switch (widget.type) {
    case "counter":
    case "counter-group":
      // Counter entries just count as 1 occurrence
      values.push(1);
      break;

    case "number":
      if (typeof data.value === "number") values.push(data.value);
      break;

    case "rating":
      if (typeof data.rating === "number") values.push(data.rating);
      break;

    case "combo":
      // Extract numeric values from combo fields
      for (const field of (widget as ComboWidgetType).fields) {
        const fieldValue = data[field.id];
        if (typeof fieldValue === "number") {
          values.push(fieldValue);
        }
      }
      break;

    case "text":
      // Text entries don't have numeric values
      break;
  }

  return values;
}

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

function getMonthData(entries: LogEntry[], widgetIds: string[], year: number, month: number, widget: Widget, fieldId?: string): DayData[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const data: DayData[] = [];
  const idSet = new Set(widgetIds);

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
      (e) => idSet.has(e.subjectId) && e.timestamp >= dayStart && e.timestamp <= dayEnd
    );

    const values: number[] = [];
    dayEntries.forEach((e) => {
      values.push(...extractNumericValues(e, widget, fieldId));
    });

    data.push({ date, count: dayEntries.length, values });
  }

  return data;
}

function getLast30DaysData(entries: LogEntry[], widgetIds: string[], widget: Widget, fieldId?: string): { date: string; value: number; count: number }[] {
  const data: { date: string; value: number; count: number }[] = [];
  const today = new Date();
  const idSet = new Set(widgetIds);

  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const dayEntries = entries.filter(
      (e) => idSet.has(e.subjectId) && e.timestamp >= date && e.timestamp <= dayEnd
    );

    const values: number[] = [];
    dayEntries.forEach((e) => {
      values.push(...extractNumericValues(e, widget, fieldId));
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

function getWeeklyData(entries: LogEntry[], widgetIds: string[], widget: Widget, fieldId?: string): { week: string; total: number; avg: number }[] {
  const data: { week: string; total: number; avg: number }[] = [];
  const today = new Date();
  const idSet = new Set(widgetIds);

  for (let w = 11; w >= 0; w--) {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - (w * 7 + today.getDay()));
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const weekEntries = entries.filter(
      (e) => idSet.has(e.subjectId) && e.timestamp >= weekStart && e.timestamp <= weekEnd
    );

    const values: number[] = [];
    weekEntries.forEach((e) => {
      values.push(...extractNumericValues(e, widget, fieldId));
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
  widgetIds,
  widget,
  fieldId,
}: {
  entries: LogEntry[];
  widgetIds: string[];
  widget: Widget;
  fieldId?: string;
}) {
  const [viewDate, setViewDate] = useState(new Date());
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const monthData = useMemo(() => getMonthData(entries, widgetIds, year, month, widget, fieldId), [entries, widgetIds, year, month, widget, fieldId]);
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
  widgetIds,
  widget,
  fieldId,
}: {
  entries: LogEntry[];
  widgetIds: string[];
  widget: Widget;
  fieldId?: string;
}) {
  const data = useMemo(() => getLast30DaysData(entries, widgetIds, widget, fieldId), [entries, widgetIds, widget, fieldId]);

  // Calculate stats
  const values = data.filter((d) => d.value > 0).map((d) => d.value);
  const avgValue = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const daysWithData = values.length;
  const maxVal = Math.max(...values, 0);

  // Determine if this is a counter (show bar) or value (show line)
  const isCounter = widget.type === "counter" || widget.type === "counter-group";

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
  widgetIds,
  widget,
  fieldId,
}: {
  entries: LogEntry[];
  widgetIds: string[];
  widget: Widget;
  fieldId?: string;
}) {
  const data = useMemo(() => getWeeklyData(entries, widgetIds, widget, fieldId), [entries, widgetIds, widget, fieldId]);

  const isCounter = widget.type === "counter" || widget.type === "counter-group";
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

// Represents a selectable item for visualization
interface VisualizableItem {
  id: string;           // Unique ID for selection
  label: string;        // Display name
  widget: Widget;       // Parent widget (for type detection)
  entryIds: string[];   // Entry IDs to filter by
  fieldId?: string;     // For combo fields, the specific field to extract
}

// Build a flat list of all visualizable items (expands counter-groups, combo widgets, and sample questions)
function buildVisualizableItems(widgets: Widget[], sampleQuestions: SampleQuestion[]): VisualizableItem[] {
  const items: VisualizableItem[] = [];

  for (const widget of widgets) {
    if (widget.type === "counter-group") {
      const groupWidget = widget as CounterGroupWidgetType;
      // Add the group itself (all counters combined)
      items.push({
        id: widget.id,
        label: `${widget.label} (all)`,
        widget,
        entryIds: groupWidget.counters.map(c => c.id),
      });
      // Add each individual counter
      for (const counter of groupWidget.counters) {
        items.push({
          id: `${widget.id}:${counter.id}`,
          label: `${widget.label} › ${counter.label}`,
          widget: { ...widget, type: "counter" } as Widget, // Treat as single counter for viz
          entryIds: [counter.id],
        });
      }
    } else if (widget.type === "combo") {
      const comboWidget = widget as ComboWidgetType;
      // Add each field as a separate visualizable item
      for (const field of comboWidget.fields) {
        // Create a virtual widget for this field based on field type
        const virtualWidget: Widget = field.type === "number"
          ? { id: `${widget.id}:${field.id}`, type: "number", label: field.label, min: field.min, max: field.max, unit: field.unit }
          : field.type === "rating"
          ? { id: `${widget.id}:${field.id}`, type: "rating", label: field.label, max: field.max || 5 }
          : { id: `${widget.id}:${field.id}`, type: "text", label: field.label };

        items.push({
          id: `${widget.id}:${field.id}`,
          label: `${widget.label} › ${field.label}`,
          widget: virtualWidget,
          entryIds: [widget.id], // Combo entries use the parent widget ID
          fieldId: field.id,    // Track which field to extract
        });
      }
    } else {
      items.push({
        id: widget.id,
        label: widget.label,
        widget,
        entryIds: [widget.id],
      });
    }
  }

  // Add sample questions as visualizable items
  for (const question of sampleQuestions) {
    // Create a virtual widget for this sample question based on question type
    const virtualWidget: Widget = question.type === "number"
      ? { id: `sample:${question.id}`, type: "number", label: question.label, min: question.min }
      : question.type === "rating"
      ? { id: `sample:${question.id}`, type: "rating", label: question.label, max: question.max || 5 }
      : { id: `sample:${question.id}`, type: "text", label: question.label };

    items.push({
      id: `sample:${question.id}`,
      label: `Sample › ${question.label}`,
      widget: virtualWidget,
      entryIds: ["__sample__"], // Sample entries use "__sample__" as subjectId
      fieldId: question.id,    // Track which field to extract from sample data
    });
  }

  return items;
}

export function Visualizations() {
  const { state } = useLife();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const widgets = state.log?.manifest.widgets || [];
  const sampleQuestions = state.log?.manifest.randomSamples?.questions || [];
  const entries = Array.from(state.entries.values());

  // Build flat list of visualizable items
  const visualizableItems = useMemo(() => buildVisualizableItems(widgets, sampleQuestions), [widgets, sampleQuestions]);

  // Find selected item (default to first)
  const currentId = selectedId || visualizableItems[0]?.id;
  const selectedItem = visualizableItems.find(item => item.id === currentId);

  if (visualizableItems.length === 0) {
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

  const widgetOptions = visualizableItems.map((item) => ({
    value: item.id,
    label: item.label,
  }));

  const tabItems = [
    {
      key: "trend",
      label: "Daily Trend",
      children: selectedItem && (
        <TrendChart entries={entries} widgetIds={selectedItem.entryIds} widget={selectedItem.widget} fieldId={selectedItem.fieldId} />
      ),
    },
    {
      key: "weekly",
      label: "Weekly",
      children: selectedItem && (
        <WeeklyChart entries={entries} widgetIds={selectedItem.entryIds} widget={selectedItem.widget} fieldId={selectedItem.fieldId} />
      ),
    },
    {
      key: "calendar",
      label: "Calendar",
      children: selectedItem && (
        <CalendarHeatMap entries={entries} widgetIds={selectedItem.entryIds} widget={selectedItem.widget} fieldId={selectedItem.fieldId} />
      ),
    },
  ];

  return (
    <Container>
      <Header>
        <BackButton type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("..")} />
        <Title>Insights</Title>
        <WidgetSelect
          value={currentId}
          onChange={(value) => setSelectedId(value as string)}
          options={widgetOptions}
        />
      </Header>

      <Tabs items={tabItems} />
    </Container>
  );
}
