import { useMemo, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Tag,
  Empty,
  Spin,
  Typography,
  Space,
  Popconfirm,
  Tabs,
  Select,
  Popover,
  Collapse,
} from "antd";
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  FlagOutlined,
  FlagFilled,
  DeleteOutlined,
  EditOutlined,
  HomeOutlined,
  EnvironmentOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  SwapOutlined,
  BuildOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { WideContainer } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { useTravelBackend } from "../backend-provider";
import { daysToBackend } from "../adapters";
import {
  STATUS_COLORS,
  formatDateRange,
  calculateDayLoad,
  type Activity,
  type Itinerary,
  type DayLoad,
} from "../types";
import { ItineraryBuilder } from "./ItineraryBuilder";
import { ItineraryCompare } from "./ItineraryCompare";
import { ItineraryMap } from "./ItineraryMap";
import { ReadinessDashboard } from "./ReadinessDashboard";
import { TripChecklist } from "./TripChecklist";

// Helper: get activities for a specific trip
function getActivitiesForTrip(
  activities: Map<string, Activity>,
  tripId: string
) {
  return Array.from(activities.values()).filter((a) => a.tripId === tripId);
}

// Helper: get itineraries for a specific trip
function getItinerariesForTrip(
  itineraries: Map<string, Itinerary>,
  tripId: string
) {
  return Array.from(itineraries.values()).filter((i) => i.tripId === tripId);
}

// Link helpers
function mapsUrl(activity: Activity): string | null {
  if (activity.placeId) return `https://www.google.com/maps/place/?q=place_id:${activity.placeId}`;
  if (activity.lat != null && activity.lng != null) return `https://www.google.com/maps/@${activity.lat},${activity.lng},15z`;
  if (activity.location) return `https://www.google.com/maps/search/${encodeURIComponent(activity.location)}`;
  return null;
}

function sourceRefUrl(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("Gmail:")) return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(trimmed.slice(6).trim())}`;
  if (trimmed.startsWith("Calendar:")) return "https://calendar.google.com";
  if (trimmed.startsWith("Drive:")) return `https://drive.google.com/drive/search?q=${encodeURIComponent(trimmed.slice(6).trim())}`;
  return null;
}

const TwoColumn = styled.div`
  display: grid;
  grid-template-columns: 1fr 400px;
  gap: 24px;
  align-items: start;

  @media (max-width: 1000px) {
    grid-template-columns: 1fr;
  }
`;

const StickyMap = styled.div`
  position: sticky;
  top: 72px;

  @media (max-width: 1000px) {
    position: static;
    order: -1;
  }
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

const BackLink = styled.button`
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: #8c8c8c;
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  margin-bottom: 12px;

  &:hover {
    color: #595959;
  }
`;

const TripHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  line-height: 1.2;
`;

const MetaBar = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  color: #8c8c8c;
  font-size: 14px;
  margin-bottom: 24px;
  flex-wrap: wrap;
`;

const MetaItem = styled.span`
  display: flex;
  align-items: center;
  gap: 5px;
`;

const FlagBanner = styled.div`
  background: #fff7e6;
  border: 1px solid #ffd591;
  border-radius: 8px;
  padding: 10px 16px;
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #ad6800;
  font-size: 14px;
`;

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

const NotesCard = styled.div`
  background: #fafafa;
  border-radius: 8px;
  padding: 16px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.7;
  color: #595959;
`;

const SourceRef = styled.div<{ $type: string }>`
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 13px;
  background: ${(p) => {
    switch (p.$type) {
      case "Gmail": return "#fff1f0";
      case "Drive": return "#f6ffed";
      case "Calendar": return "#e6f4ff";
      default: return "#fafafa";
    }
  }};
  border-left: 3px solid ${(p) => {
    switch (p.$type) {
      case "Gmail": return "#ff4d4f";
      case "Drive": return "#52c41a";
      case "Calendar": return "#1677ff";
      default: return "#d9d9d9";
    }
  }};
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

export function TripDetail() {
  const { tripId } = useParams<{ tripId: string }>();
  const navigate = useNavigate();
  const { state } = useTravelContext();
  const travel = useTravelBackend();

  const trip = tripId ? state.trips.get(tripId) : undefined;

  const activities = useMemo(
    () => (tripId ? getActivitiesForTrip(state.activities, tripId) : []),
    [state.activities, tripId]
  );

  const itineraries = useMemo(
    () => (tripId ? getItinerariesForTrip(state.itineraries, tripId) : []),
    [state.itineraries, tripId]
  );

  const activityMap = useMemo(() => {
    const map = new Map<string, Activity>();
    for (const a of activities) map.set(a.id, a);
    return map;
  }, [activities]);

  const [focusDay, setFocusDay] = useState<number | null>(null);

  if (state.loading) {
    return (
      <WideContainer>
        <Spin size="large" style={{ display: "block", margin: "40px auto" }} />
      </WideContainer>
    );
  }

  if (!trip) {
    return (
      <WideContainer>
        <BackLink onClick={() => navigate(-1)}>
          <ArrowLeftOutlined /> Back
        </BackLink>
        <Empty description="Trip not found" style={{ marginTop: 40 }} />
      </WideContainer>
    );
  }

  const sourceRefLines = trip.sourceRefs
    ? trip.sourceRefs.split("\n").filter(Boolean)
    : [];

  const handleDelete = async () => {
    await travel.deleteTrip(trip.id);
    navigate(-1);
  };

  const handleToggleFlag = () => {
    travel.flagTrip(trip.id, !trip.flaggedForReview, trip.reviewComment);
  };

  const hasMapData = activities.some((a) => a.lat != null && a.lng != null);
  const searchParams = new URLSearchParams(window.location.search);
  const selectedItinId = searchParams.get("itin");
  const activeItin = (selectedItinId ? itineraries.find((i) => i.id === selectedItinId) : null)
    || itineraries.find((i) => i.isActive)
    || itineraries[0];

  return (
    <WideContainer>
      <BackLink onClick={() => navigate(-1)}>
        <ArrowLeftOutlined /> Back to trips
      </BackLink>

      <TripHeader>
        <div>
          <Title>{trip.destination}</Title>
        </div>
        <Space>
          <Button
            size="small"
            icon={trip.flaggedForReview ? <FlagFilled style={{ color: "#fa541c" }} /> : <FlagOutlined />}
            onClick={handleToggleFlag}
          />
          <Button size="small" icon={<EditOutlined />} onClick={() => navigate("edit")} />
          <Popconfirm title="Delete this trip?" onConfirm={handleDelete}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      </TripHeader>

      <MetaBar>
        <Tag color={STATUS_COLORS[trip.status]} style={{ margin: 0 }}>
          {trip.status}
        </Tag>
        {trip.region && (
          <MetaItem>
            <EnvironmentOutlined /> {trip.region}
          </MetaItem>
        )}
        {(trip.startDate || trip.endDate) && (
          <MetaItem>
            <CalendarOutlined /> {formatDateRange(trip)}
          </MetaItem>
        )}
        <MetaItem>{activities.length} activities</MetaItem>
      </MetaBar>

      {trip.flaggedForReview && trip.reviewComment && (
        <FlagBanner>
          <FlagFilled /> {trip.reviewComment}
        </FlagBanner>
      )}

      <TwoColumn>
        <div>
          {/* Itinerary section */}
          {itineraries.length > 0 && (
            <ItinerarySection
              itineraries={itineraries}
              activities={activities}
              activityMap={activityMap}
              focusDay={focusDay}
              onDayClick={(day) => setFocusDay(focusDay === day ? null : day)}
              onDayNav={(day) => setFocusDay(day)}
              navigate={navigate}
            />
          )}

          {/* Collapsible sections */}
          {(() => {
            const showReadiness = trip.status === "Booked" || trip.status === "Ongoing" || trip.status === "Researching";
            const panels = [];

            if (showReadiness) {
              panels.push({
                key: "readiness",
                label: "Readiness & Prep",
                children: (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <ReadinessDashboard trip={trip} activities={activities} itineraries={itineraries} />
                    <TripChecklist trip={trip} />
                  </div>
                ),
              });
            }

            if (trip.notes) {
              panels.push({
                key: "notes",
                label: "Notes",
                children: <NotesCard>{trip.notes}</NotesCard>,
              });
            }

            if (sourceRefLines.length > 0) {
              panels.push({
                key: "sources",
                label: `Sources (${sourceRefLines.length})`,
                children: (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {sourceRefLines.map((line, i) => {
                      const type = line.split(":")[0] || "Other";
                      const refUrl = sourceRefUrl(line);
                      return (
                        <SourceRef key={i} $type={type} as={refUrl ? "a" : "div"} href={refUrl || undefined} target="_blank" rel="noopener noreferrer" style={refUrl ? { cursor: "pointer" } : undefined}>
                          {line}
                        </SourceRef>
                      );
                    })}
                  </div>
                ),
              });
            }

            if (panels.length === 0) return null;

            return (
              <Collapse
                size="small"
                ghost
                defaultActiveKey={showReadiness ? ["readiness"] : []}
                items={panels}
                style={{ marginTop: 8 }}
              />
            );
          })()}
        </div>

        {/* Sticky map on the right */}
        {hasMapData && activeItin && (
          <StickyMap>
            <ItineraryMap
              itinerary={activeItin}
              activities={activities}
              activityMap={activityMap}
              focusDay={focusDay}
            />
          </StickyMap>
        )}
      </TwoColumn>
    </WideContainer>
  );
}

function ItinerarySection({
  itineraries,
  activities,
  activityMap,
  focusDay,
  onDayClick,
  onDayNav,
  navigate,
}: {
  itineraries: Itinerary[];
  activities: Activity[];
  activityMap: Map<string, Activity>;
  focusDay: number | null;
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

  const tabItems = [
    {
      key: "timeline",
      label: <span><UnorderedListOutlined /> Timeline</span>,
      children: currentItin ? (
        <ItineraryTimeline itinerary={currentItin} activityMap={activityMap} focusDay={focusDay} onDayClick={onDayClick} onDayNav={onDayNav}
          onEditActivity={(id) => navigate(`activities/${id}/edit`)}
          onDeleteActivity={(id) => travel.deleteActivity(id)} />
      ) : null,
    },
    {
      key: "builder",
      label: <span><BuildOutlined /> Builder</span>,
      children: currentItin ? (
        <ItineraryBuilder
          itinerary={currentItin}
          activities={activities}
          activityMap={activityMap}
        />
      ) : null,
    },
    ...(itineraries.length > 1
      ? [
          {
            key: "compare",
            label: <span><SwapOutlined /> Compare ({itineraries.length})</span>,
            children: (
              <ItineraryCompare
                itineraries={itineraries}
                activityMap={activityMap}
              />
            ),
          },
        ]
      : []),
  ];

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
      <Tabs items={tabItems} size="small" activeKey={activeTab} onChange={setTab} />
    </Section>
  );
}

const DayGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
`;

const CompactDayCard = styled.div`
  width: calc(33.33% - 8px);
  min-width: 200px;
  background: #fafafa;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;

  @media (max-width: 1100px) {
    width: calc(50% - 6px);
  }
  @media (max-width: 700px) {
    width: 100%;
  }
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
  justify-content: space-between;
  gap: 4px;
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


const ExpandedDay = styled.div`
  background: #f0f5ff;
  border: 2px solid #1677ff;
  border-radius: 8px;
  padding: 12px 16px;
  width: 100%;
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
        {activity.rating != null && <span style={{ color: "#fa8c16" }}>★{activity.rating}</span>}
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
  onDayClick,
  onDayNav,
  onEditActivity,
  onDeleteActivity,
}: {
  itinerary: Itinerary;
  activityMap: Map<string, Activity>;
  focusDay: number | null;
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
                onClick={() => hasPrev ? onDayNav(focusDay - 1) : undefined}
                disabled={!hasPrev} />
              <ExpandedDayTitle>Day {focusDay + 1} / {totalDays}</ExpandedDayTitle>
              <Button type="text" size="small" icon={<ArrowRightOutlined />}
                onClick={() => hasNext ? onDayNav(focusDay + 1) : undefined}
                disabled={!hasNext} />
              <Button type="text" size="small" onClick={() => onDayClick(focusDay)}
                style={{ marginLeft: 8, color: "#8c8c8c", fontSize: 12 }}>
                All days
              </Button>
              {load.totalHours > 0 && (
                <LoadBadge $level={load.level} style={{ fontSize: 11, padding: "1px 6px" }}>
                  {load.activityHours.toFixed(1)}h activities{load.driveMiles > 5 ? ` + ~${Math.round(load.driveMiles)} mi driving` : ""}
                  {load.level === "overpacked" && " ⚠ overpacked"}
                </LoadBadge>
              )}
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
                <ExpandedSlotName style={{ color: "#1677ff" }}>✈ {f.activity?.name || f.activityId}</ExpandedSlotName>
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
                    {activity?.rating != null && <span style={{ color: "#fa8c16" }}>★{activity.rating}</span>}
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
                Day {i + 1}{day.date ? ` — ${new Date(day.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}` : ""}
              </span>
              {lodging && (() => {
                const url = mapsUrl(lodging);
                return (
                  <LodgingBadge as={url ? "a" : "span"} href={url || undefined} target="_blank" rel="noopener noreferrer"
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                    <HomeOutlined /> {lodging.name}
                  </LodgingBadge>
                );
              })()}
              {load.totalHours > 0 && (
                <LoadBadge $level={load.level}>
                  {load.activityHours.toFixed(1)}h{load.driveMiles > 5 ? ` + ${Math.round(load.driveMiles)}mi` : ""}
                </LoadBadge>
              )}
            </CompactDayTitle>

            {flights.map((f, j) => (
              <CompactSlot key={`f-${j}`} style={{ color: "#1677ff" }}>
                {f.startTime && <CompactTime>{f.startTime}</CompactTime>}
                <span>✈ {f.activity?.name || f.activityId}</span>
              </CompactSlot>
            ))}

            {day.slots.map((slot, j) => {
              const activity = activityMap.get(slot.activityId);
              return (
                <Popover
                  key={j}
                  trigger="hover"
                  placement="right"
                  mouseEnterDelay={0.3}
                  content={activity ? <ActivityTooltip activity={activity} apiKey={apiKey} /> : null}
                >
                  <CompactSlot>
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
