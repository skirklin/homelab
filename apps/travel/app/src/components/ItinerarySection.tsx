import React from "react";
import { useSearchParams } from "react-router-dom";
import {
  Button,
  Empty,
  Space,
  Typography,
  Popconfirm,
  Tabs,
  Select,
  Popover,
} from "antd";
import {
  HomeOutlined,
  SwapOutlined,
  UnorderedListOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { useTravelBackend } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { daysToBackend } from "../adapters";
import { mapsUrl } from "../utils";
import {
  calculateDayLoad,
  validateDay,
  type Activity,
  type Itinerary,
  type DayLoad,
  type DayIssue,
} from "../types";
import type { DayRouteInfo } from "./ItineraryMap";
import { ItineraryCompare } from "./ItineraryCompare";

const Section = styled.div`
  margin-bottom: 28px;
`;

const SectionHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
`;

const SectionTitle = styled.h2`
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #262626;
`;

const LodgingBadge = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 500;
  color: #fa8c16;
  background: #fff7e6;
  border: 1px solid #ffd591;
  border-radius: 3px;
  padding: 0 6px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
`;

const DayGrid = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 500px;
`;

const CompactDayCard = styled.div`
  background: #fafafa;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  cursor: pointer;
  &:hover { background: #f0f0f0; }
`;

const LOAD_COLORS = {
  light: "#52c41a",
  moderate: "#1677ff",
  full: "#fa8c16",
  overpacked: "#ff4d4f",
};

const LoadBadge = styled.span<{ $level: DayLoad["level"] }>`
  font-size: 9px;
  font-weight: 600;
  color: ${(p) => LOAD_COLORS[p.$level]};
  background: ${(p) => LOAD_COLORS[p.$level]}15;
  border-radius: 3px;
  padding: 0 4px;
  white-space: nowrap;
`;

const IssuesBadge = styled.span`
  font-size: 9px;
  font-weight: 600;
  color: #fa8c16;
  background: #fa8c1615;
  border-radius: 3px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: help;
`;

function DayIssuesIndicator({ issues, style }: { issues: DayIssue[]; style?: React.CSSProperties }) {
  if (issues.length === 0) return null;
  const tooltip = (
    <ul style={{ margin: 0, paddingLeft: 16, maxWidth: 320 }}>
      {issues.map((issue, i) => (
        <li key={i} style={{ lineHeight: 1.4 }}>{issue.message}</li>
      ))}
    </ul>
  );
  return (
    <Popover content={tooltip} trigger={["hover", "focus"]} placement="bottom">
      <IssuesBadge
        style={style}
        tabIndex={0}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <WarningOutlined /> {issues.length}
      </IssuesBadge>
    </Popover>
  );
}

const CompactDayTitle = styled.div`
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 4px;
  padding-bottom: 3px;
  border-bottom: 1px solid #e8e8e8;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
`;

const CompactSlot = styled.div`
  display: flex;
  align-items: baseline;
  gap: 3px;
  padding: 1px 0;
  font-size: 11px;
  line-height: 1.3;
`;

const CompactTime = styled.span`
  color: #1677ff;
  font-size: 10px;
  font-weight: 500;
  flex-shrink: 0;
`;

const CompactName = styled.span`
  font-weight: 500;
`;

function ItineraryTimeline({
  itinerary,
  activityMap,
  routeInfo,
  onDayOpen,
}: {
  itinerary: Itinerary;
  activityMap: Map<string, Activity>;
  routeInfo?: DayRouteInfo;
  /** Called when a day card is clicked. Caller routes to the day view. */
  onDayOpen: (day: { index: number; date?: string }) => void;
}) {
  if (itinerary.days.length === 0) {
    return <Empty description="No days planned" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <DayGrid>
      {itinerary.days.map((day, i) => {
        const lodging = day.lodgingActivityId ? activityMap.get(day.lodgingActivityId) : null;
        const prevLodgingId = i > 0 ? itinerary.days[i - 1].lodgingActivityId : null;
        const lodgingChanged = lodging && day.lodgingActivityId !== prevLodgingId;
        const flights = (day.flights || []).map((f) => ({
          ...f,
          activity: activityMap.get(f.activityId),
        }));
        const dayActivities = day.slots
          .map((s) => activityMap.get(s.activityId))
          .filter((a): a is Activity => a != null);
        const load = calculateDayLoad(dayActivities);
        const issues = validateDay(day.slots, activityMap);

        return (
          <CompactDayCard key={i} onClick={() => onDayOpen({ index: i, date: day.date })}>
            <CompactDayTitle>
              <span>
                Day {i + 1}{day.date ? ` — ${new Date(day.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}` : ""}
              </span>
              {lodgingChanged && (() => {
                const url = mapsUrl(lodging);
                return (
                  <LodgingBadge as={url ? "a" : "span"} href={url || undefined} target="_blank" rel="noopener noreferrer"
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                    <HomeOutlined /> {lodging.name}
                  </LodgingBadge>
                );
              })()}
              {load.totalHours > 0 && (() => {
                const ri = routeInfo?.[i];
                const hasDriving = load.driveMiles > 5;
                const driveStr = ri
                  ? `${Math.round(ri.durationMinutes / 60 * 10) / 10}h`
                  : hasDriving ? "?" : "";
                return (
                  <LoadBadge $level={load.level}>
                    {load.activityHours.toFixed(1)}h{driveStr ? ` + ${driveStr} drive` : ""}
                  </LoadBadge>
                );
              })()}
              <DayIssuesIndicator issues={issues} />
            </CompactDayTitle>

            {flights.map((f, j) => (
              <CompactSlot key={`f-${j}`} style={{ color: "#1677ff" }}>
                {f.startTime && <CompactTime>{f.startTime}</CompactTime>}
                <span>{"✈"} {f.activity?.name || f.activityId}</span>
              </CompactSlot>
            ))}

            {day.slots.map((slot, j) => {
              const activity = activityMap.get(slot.activityId);
              return (
                <CompactSlot key={j}>
                  {slot.startTime && <CompactTime>{slot.startTime}</CompactTime>}
                  <CompactName>{activity?.name || slot.activityId}</CompactName>
                </CompactSlot>
              );
            })}

            {day.slots.length === 0 && flights.length === 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>No activities</Typography.Text>
            )}
          </CompactDayCard>
        );
      })}
    </DayGrid>
  );
}

export function ItinerarySection({
  itineraries,
  activityMap,
  routeInfo,
  navigate,
}: {
  itineraries: Itinerary[];
  activityMap: Map<string, Activity>;
  routeInfo?: DayRouteInfo;
  navigate: (path: string) => void;
}) {
  const travel = useTravelBackend();
  const { state } = useTravelContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("view") || "timeline";
  const selectedItin = searchParams.get("itin") || itineraries.find((i) => i.isActive)?.id || itineraries[0]?.id;

  const setTab = (tab: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("view", tab);
      return next;
    }, { replace: true });
  };

  const setSelectedItin = (id: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("itin", id);
      return next;
    }, { replace: true });
  };

  const currentItin = itineraries.find((i) => i.id === selectedItin);

  const timeline = currentItin ? (
    <ItineraryTimeline
      itinerary={currentItin}
      activityMap={activityMap}
      routeInfo={routeInfo}
      onDayOpen={(d) => {
        if (d.date) navigate(`day/${d.date}`);
      }}
    />
  ) : null;

  const tabItems = itineraries.length > 1 ? [
    {
      key: "timeline",
      label: <span><UnorderedListOutlined /> Timeline</span>,
      children: timeline,
    },
    {
      key: "compare",
      label: <span><SwapOutlined /> Compare ({itineraries.length})</span>,
      children: (
        <ItineraryCompare itineraries={itineraries} activityMap={activityMap} />
      ),
    },
  ] : null;

  const handleCreateItinerary = async () => {
    const tripId = currentItin?.tripId;
    const logId = state.log?.id;
    if (!tripId || !logId) return;
    const name = window.prompt("Itinerary name:", "Option " + String.fromCharCode(65 + itineraries.length));
    if (!name) return;
    await travel.addItinerary(logId, tripId, { name, days: [] });
  };

  const handleRenameItinerary = async () => {
    if (!currentItin) return;
    const name = window.prompt("Rename itinerary:", currentItin.name);
    if (!name || name === currentItin.name) return;
    await travel.updateItinerary(currentItin.id, { name });
  };

  const handleDeleteItinerary = async () => {
    if (!currentItin || itineraries.length <= 1) return;
    if (!window.confirm(`Delete itinerary "${currentItin.name}"?`)) return;
    await travel.deleteItinerary(currentItin.id);
  };

  const handleDuplicateItinerary = async () => {
    if (!currentItin) return;
    const logId = state.log?.id;
    if (!logId) return;
    const name = window.prompt("Name for copy:", `${currentItin.name} (copy)`);
    if (!name) return;
    await travel.addItinerary(logId, currentItin.tripId, { name, days: daysToBackend(currentItin.days) });
  };

  return (
    <Section>
      <SectionHeader>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SectionTitle>Itinerary</SectionTitle>
          {itineraries.length > 1 && (
            <Select
              size="small"
              value={selectedItin}
              onChange={setSelectedItin}
              style={{ minWidth: 120 }}
              options={itineraries.map((i) => ({
                label: `${i.name}${i.isActive ? " (active)" : ""}`,
                value: i.id,
              }))}
            />
          )}
        </div>
        <Space size={4}>
          <Button size="small" type="text" onClick={handleCreateItinerary}>New</Button>
          <Button size="small" type="text" onClick={handleRenameItinerary}>Rename</Button>
          <Button size="small" type="text" onClick={handleDuplicateItinerary}>Duplicate</Button>
          {itineraries.length > 1 && (
            <Popconfirm title={`Delete "${currentItin?.name}"?`} onConfirm={handleDeleteItinerary}>
              <Button size="small" type="text" danger>Delete</Button>
            </Popconfirm>
          )}
        </Space>
      </SectionHeader>
      {tabItems
        ? <Tabs items={tabItems} size="small" activeKey={activeTab} onChange={setTab} />
        : timeline}
    </Section>
  );
}
