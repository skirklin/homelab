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
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  HomeOutlined,
  EnvironmentOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  SwapOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { useTravelBackend } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { daysToBackend } from "../adapters";
import { mapsUrl } from "../utils";
import {
  calculateDayLoad,
  type Activity,
  type Itinerary,
  type DayLoad,
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

const ExternalLink = styled.a`
  color: inherit;
  text-decoration: none;
  &:hover { text-decoration: underline; color: #1677ff; }
`;

const ConfCode = styled.code`
  font-family: monospace;
  font-size: 11px;
  background: #f5f5f5;
  padding: 1px 5px;
  border-radius: 3px;
  cursor: pointer;
  &:hover { background: #e8e8e8; }
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
  cursor: pointer;
  &:hover {
    color: #1677ff;
    text-decoration: underline;
  }
`;

const ExpandedDay = styled.div`
  background: #f0f5ff;
  border: 2px solid #1677ff;
  border-radius: 8px;
  padding: 12px 16px;
  max-width: 500px;
`;

const ExpandedDayHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid #d6e4ff;
`;

const ExpandedDayTitle = styled.div`
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
`;

const ExpandedSlot = styled.div`
  display: flex;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid #f0f0f0;
  align-items: flex-start;
  &:last-child { border-bottom: none; }
`;

const ExpandedSlotTime = styled.div`
  color: #1677ff;
  font-size: 12px;
  font-weight: 500;
  min-width: 60px;
  flex-shrink: 0;
  padding-top: 1px;
`;

const ExpandedSlotBody = styled.div`
  flex: 1;
  min-width: 0;
`;

const ExpandedSlotName = styled.div`
  font-size: 13px;
  font-weight: 500;
`;

const ExpandedSlotMeta = styled.div`
  font-size: 11px;
  color: #8c8c8c;
  display: flex;
  gap: 8px;
  margin-top: 2px;
`;

const ExpandedSlotDesc = styled.div`
  font-size: 11px;
  color: #595959;
  margin-top: 2px;
`;

const ExpandedSlotPhoto = styled.img`
  width: 60px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
`;

const HoverTooltip = styled.div`
  max-width: 250px;
  font-size: 12px;
`;

const HoverPhoto = styled.img`
  width: 100%;
  height: 80px;
  object-fit: cover;
  border-radius: 4px;
  margin-bottom: 4px;
`;

const HoverMeta = styled.div`
  color: #8c8c8c;
  font-size: 11px;
  display: flex;
  gap: 6px;
  margin-top: 2px;
`;

function ActivityTooltip({ activity, apiKey }: { activity: Activity; apiKey: string }) {
  return (
    <HoverTooltip>
      {activity.photoRef && (
        <HoverPhoto
          src={`https://places.googleapis.com/v1/${activity.photoRef}/media?maxWidthPx=250&key=${apiKey}`}
          alt={activity.name}
        />
      )}
      <div style={{ fontWeight: 500 }}>{activity.name}</div>
      <HoverMeta>
        {activity.rating != null && <span style={{ color: "#fa8c16" }}>&#9733;{activity.rating}</span>}
        {activity.location && <span><EnvironmentOutlined /> {activity.location}</span>}
        {activity.durationEstimate && <span><ClockCircleOutlined /> {activity.durationEstimate}</span>}
        {activity.costNotes && <span><DollarOutlined /> {activity.costNotes}</span>}
      </HoverMeta>
      {activity.description && <div style={{ color: "#595959", marginTop: 3, fontStyle: "italic" }}>{activity.description}</div>}
      {activity.details && <div style={{ color: "#595959", marginTop: 4, fontSize: 11, lineHeight: 1.4, whiteSpace: "pre-wrap" }}>{activity.details}</div>}
    </HoverTooltip>
  );
}

function ItineraryTimeline({
  itinerary,
  activityMap,
  focusDay,
  routeInfo,
  onDayClick,
  onDayNav,
  onEditActivity,
  onDeleteActivity,
}: {
  itinerary: Itinerary;
  activityMap: Map<string, Activity>;
  focusDay: number | null;
  routeInfo?: DayRouteInfo;
  onDayClick: (dayIndex: number) => void;
  onDayNav: (dayIndex: number) => void;
  onEditActivity: (activityId: string) => void;
  onDeleteActivity: (activityId: string) => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiKey = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || "";

  if (itinerary.days.length === 0) {
    return <Empty description="No days planned" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  // Expanded single-day view
  if (focusDay != null) {
    const day = itinerary.days[focusDay];
    if (!day) return null;
    const lodging = day.lodgingActivityId ? activityMap.get(day.lodgingActivityId) : null;
    const flights = (day.flights || []).map((f) => ({ ...f, activity: activityMap.get(f.activityId) }));
    const expandedActivities = day.slots
      .map((s) => activityMap.get(s.activityId))
      .filter((a): a is Activity => a != null);
    const load = calculateDayLoad(expandedActivities);

    const totalDays = itinerary.days.length;
    const hasPrev = focusDay > 0;
    const hasNext = focusDay < totalDays - 1;

    return (
      <div>
        <ExpandedDay>
          <ExpandedDayHeader>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Button type="text" size="small" icon={<ArrowLeftOutlined />}
                onClick={() => onDayClick(focusDay)}
                title="Back to all days" />
              <Button type="text" size="small"
                onClick={() => hasPrev ? onDayNav(focusDay - 1) : undefined}
                disabled={!hasPrev} style={{ fontSize: 11, padding: "0 4px" }}>‹</Button>
              <ExpandedDayTitle>Day {focusDay + 1} / {totalDays}</ExpandedDayTitle>
              <Button type="text" size="small"
                onClick={() => hasNext ? onDayNav(focusDay + 1) : undefined}
                disabled={!hasNext} style={{ fontSize: 11, padding: "0 4px" }}>›</Button>
              {load.totalHours > 0 && (() => {
                const ri = routeInfo?.[focusDay];
                const hasDriving = load.driveMiles > 5;
                const driveStr = ri
                  ? `${Math.round(ri.durationMinutes / 60 * 10) / 10}h driving`
                  : hasDriving ? "? driving" : "";
                return (
                  <LoadBadge $level={load.level} style={{ fontSize: 11, padding: "1px 6px" }}>
                    {load.activityHours.toFixed(1)}h activities{driveStr ? ` + ${driveStr}` : ""}
                    {load.level === "overpacked" && " \u26a0 overpacked"}
                  </LoadBadge>
                );
              })()}
            </div>
            {lodging && (() => {
              const url = mapsUrl(lodging);
              return (
                <LodgingBadge as={url ? "a" : "span"} href={url || undefined} target="_blank" rel="noopener noreferrer">
                  <HomeOutlined /> {lodging.name}
                </LodgingBadge>
              );
            })()}
          </ExpandedDayHeader>

          {flights.map((f, j) => (
            <ExpandedSlot key={`f-${j}`}>
              <ExpandedSlotTime>{f.startTime || ""}</ExpandedSlotTime>
              <ExpandedSlotBody>
                <ExpandedSlotName style={{ color: "#1677ff" }}>{"\u2708"} {f.activity?.name || f.activityId}</ExpandedSlotName>
                {f.activity?.description && <ExpandedSlotDesc>{f.activity.description}</ExpandedSlotDesc>}
                {f.activity?.confirmationCode && (
                  <ExpandedSlotMeta>
                    <ConfCode onClick={() => navigator.clipboard.writeText(f.activity!.confirmationCode)} title="Click to copy">
                      {f.activity.confirmationCode}
                    </ConfCode>
                  </ExpandedSlotMeta>
                )}
              </ExpandedSlotBody>
            </ExpandedSlot>
          ))}

          {day.slots.map((slot, j) => {
            const activity = activityMap.get(slot.activityId);
            const actUrl = activity ? mapsUrl(activity) : null;
            return (
              <ExpandedSlot key={j}>
                <ExpandedSlotTime>{slot.startTime || ""}</ExpandedSlotTime>
                {activity?.photoRef && (
                  <ExpandedSlotPhoto
                    src={`https://places.googleapis.com/v1/${activity.photoRef}/media?maxWidthPx=120&key=${apiKey}`}
                    alt={activity.name}
                  />
                )}
                <ExpandedSlotBody>
                  <ExpandedSlotName>
                    {activity?.name || slot.activityId}
                    {actUrl && (
                      <ExternalLink href={actUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#8c8c8c", marginLeft: 4, fontSize: 11 }}>
                        <EnvironmentOutlined />
                      </ExternalLink>
                    )}
                  </ExpandedSlotName>
                  <ExpandedSlotMeta>
                    {activity?.rating != null && <span style={{ color: "#fa8c16" }}>&#9733;{activity.rating}</span>}
                    {activity?.location && (
                      <ExternalLink href={`https://www.google.com/maps/search/${encodeURIComponent(activity.location)}`} target="_blank" rel="noopener noreferrer" style={{ color: "#8c8c8c" }}>
                        {activity.location}
                      </ExternalLink>
                    )}
                    {activity?.durationEstimate && <span><ClockCircleOutlined /> {activity.durationEstimate}</span>}
                    {activity?.costNotes && <span><DollarOutlined /> {activity.costNotes}</span>}
                  </ExpandedSlotMeta>
                  {activity?.description && <ExpandedSlotDesc style={{ fontStyle: "italic" }}>{activity.description}</ExpandedSlotDesc>}
                  {activity?.details && <ExpandedSlotDesc style={{ whiteSpace: "pre-wrap" }}>{activity.details}</ExpandedSlotDesc>}
                  {slot.notes && <ExpandedSlotDesc style={{ fontStyle: "italic", color: "#8c8c8c" }}>{slot.notes}</ExpandedSlotDesc>}
                </ExpandedSlotBody>
                <Space size={2} style={{ flexShrink: 0, alignSelf: "flex-start", paddingTop: 2 }}>
                  <Button type="text" size="small" icon={<EditOutlined />}
                    onClick={() => activity && onEditActivity(activity.id)} />
                  <Popconfirm title="Remove activity?" onConfirm={() => activity && onDeleteActivity(activity.id)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              </ExpandedSlot>
            );
          })}
        </ExpandedDay>
      </div>
    );
  }

  // Grid overview with hover tooltips
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

        return (
          <CompactDayCard key={i} onClick={() => onDayClick(i)} style={{ cursor: "pointer" }}>
            <CompactDayTitle>
              <span>
                Day {i + 1}{day.date ? ` \u2014 ${new Date(day.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}` : ""}
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
            </CompactDayTitle>

            {flights.map((f, j) => (
              <CompactSlot key={`f-${j}`} style={{ color: "#1677ff" }}>
                {f.startTime && <CompactTime>{f.startTime}</CompactTime>}
                <span>{"\u2708"} {f.activity?.name || f.activityId}</span>
              </CompactSlot>
            ))}

            {day.slots.map((slot, j) => {
              const activity = activityMap.get(slot.activityId);
              return (
                <Popover
                  key={j}
                  trigger="click"
                  placement="right"
                  content={activity ? <ActivityTooltip activity={activity} apiKey={apiKey} /> : null}
                >
                  <CompactSlot style={{ cursor: "pointer" }} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                    {slot.startTime && <CompactTime>{slot.startTime}</CompactTime>}
                    <CompactName>{activity?.name || slot.activityId}</CompactName>
                  </CompactSlot>
                </Popover>
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
  focusDay,
  routeInfo,
  onDayClick,
  onDayNav,
  navigate,
}: {
  itineraries: Itinerary[];
  activityMap: Map<string, Activity>;
  focusDay: number | null;
  routeInfo?: DayRouteInfo;
  onDayClick: (dayIndex: number) => void;
  onDayNav: (dayIndex: number) => void;
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
    <ItineraryTimeline itinerary={currentItin} activityMap={activityMap} focusDay={focusDay} routeInfo={routeInfo} onDayClick={onDayClick} onDayNav={onDayNav}
      onEditActivity={(id) => navigate(`activities/${id}/edit`)}
      onDeleteActivity={(id) => travel.deleteActivity(id)} />
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
