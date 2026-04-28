import { useMemo, useState } from "react";
import { Empty, Input, Tooltip } from "antd";
import { CalendarOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useTravelBackend } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { getDayEntriesForTrip } from "../utils";
import { localYmd, type Activity, type DayEntry, type Itinerary, type Trip } from "../types";
import { VerdictButtons } from "./VerdictButtons";

const DayCard = styled.div`
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
  background: #fff;
`;

const DayHeader = styled.div`
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
`;

const DayLabel = styled.div`
  font-weight: 600;
  font-size: 14px;
`;

const DayDate = styled.div`
  font-size: 12px;
  color: #8c8c8c;
`;

const ActivityRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
`;

const ActivityName = styled.div`
  color: #595959;
  flex: 1;
`;

const SectionLabel = styled.div`
  font-size: 11px;
  font-weight: 500;
  color: #8c8c8c;
  margin: 8px 0 4px;
  letter-spacing: 0.4px;
`;

interface DayDescriptor {
  date: string; // YYYY-MM-DD
  label: string; // "Day 2 — Sun Sep 8" etc.
  activityIds: string[];
}

function buildDays(trip: Trip, activeItin: Itinerary | undefined): DayDescriptor[] {
  // Prefer the active itinerary's day structure (gives nice labels and the
  // activity↔day mapping). Fall back to start/end dates if no itinerary.
  if (activeItin && activeItin.days.length > 0) {
    return activeItin.days
      .filter((d) => !!d.date)
      .map((d) => ({
        date: d.date!,
        label: d.label || `Day`,
        activityIds: [
          ...(d.flights?.map((f) => f.activityId) ?? []),
          ...(d.lodgingActivityId ? [d.lodgingActivityId] : []),
          ...(d.slots?.map((s) => s.activityId) ?? []),
        ],
      }));
  }
  if (!trip.startDate || !trip.endDate) return [];
  const out: DayDescriptor[] = [];
  const cur = new Date(trip.startDate);
  let i = 1;
  while (cur <= trip.endDate) {
    out.push({ date: localYmd(cur), label: `Day ${i}`, activityIds: [] });
    cur.setDate(cur.getDate() + 1);
    i++;
  }
  return out;
}

interface DayEntryEditorProps {
  trip: Trip;
  logId: string;
  day: DayDescriptor;
  entry: DayEntry | undefined;
  activities: Activity[];
}

function formatHumanDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function DayEntryEditor({ trip, logId, day, entry, activities }: DayEntryEditorProps) {
  const travel = useTravelBackend();

  // Local draft state so typing isn't fighting subscription updates.
  const [highlight, setHighlight] = useState(entry?.highlight ?? "");
  const [text, setText] = useState(entry?.text ?? "");

  const persist = (fields: { highlight?: string; text?: string }) => {
    travel.upsertDayEntry(logId, trip.id, day.date, fields);
  };

  return (
    <DayCard>
      <DayHeader>
        <DayLabel>{day.label}</DayLabel>
        <DayDate>
          <CalendarOutlined /> {formatHumanDate(day.date)}
        </DayDate>
      </DayHeader>

      <Input
        placeholder="Best moment of the day…"
        value={highlight}
        onChange={(e) => setHighlight(e.target.value)}
        onBlur={() => {
          if ((entry?.highlight ?? "") !== highlight) persist({ highlight });
        }}
        maxLength={500}
      />

      <Input.TextArea
        placeholder="What happened? How did it feel? What surprised you?"
        autoSize={{ minRows: 3, maxRows: 12 }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if ((entry?.text ?? "") !== text) persist({ text });
        }}
        maxLength={20000}
        style={{ marginTop: 8 }}
      />

      {activities.length > 0 && (
        <>
          <SectionLabel>ACTIVITIES</SectionLabel>
          {activities.map((a) => (
            <ActivityRow key={a.id}>
              <ActivityName>{a.name}</ActivityName>
              <Tooltip title="Tap a face to record how you felt about this activity">
                <span>
                  <VerdictButtons activityId={a.id} current={a.verdict} />
                </span>
              </Tooltip>
            </ActivityRow>
          ))}
        </>
      )}
    </DayCard>
  );
}

interface JournalTabProps {
  trip: Trip;
  logId: string;
  activeItinerary: Itinerary | undefined;
  activityMap: Map<string, Activity>;
}

export function JournalTab({ trip, logId, activeItinerary, activityMap }: JournalTabProps) {
  const { state } = useTravelContext();

  const dayEntries = useMemo(
    () => getDayEntriesForTrip(state.dayEntries, trip.id),
    [state.dayEntries, trip.id],
  );

  const entryByDate = useMemo(() => {
    const m = new Map<string, DayEntry>();
    for (const e of dayEntries) m.set(e.date, e);
    return m;
  }, [dayEntries]);

  const days = useMemo(() => buildDays(trip, activeItinerary), [trip, activeItinerary]);

  if (days.length === 0) {
    return <Empty description="Add trip dates to start journaling" />;
  }

  return (
    <div>
      {days.map((d) => {
        const acts = d.activityIds
          .map((id) => activityMap.get(id))
          .filter((a): a is Activity => !!a);
        return (
          <DayEntryEditor
            key={d.date}
            trip={trip}
            logId={logId}
            day={d}
            entry={entryByDate.get(d.date)}
            activities={acts}
          />
        );
      })}
    </div>
  );
}
