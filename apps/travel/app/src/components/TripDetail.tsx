import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Button,
  Tag,
  Empty,
  Spin,
  Space,
  Popconfirm,
  Tabs,
} from "antd";
import {
  ArrowLeftOutlined,
  FlagOutlined,
  FlagFilled,
  DeleteOutlined,
  EditOutlined,
  EnvironmentOutlined,
  CalendarOutlined,
  InboxOutlined,
  ScheduleOutlined,
  UnorderedListOutlined,
  CheckSquareOutlined,
  BookOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { WideContainer } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { useTravelBackend } from "@kirkl/shared";
import { getActivitiesForTrip, getItinerariesForTrip, sourceRefUrl } from "../utils";
import {
  STATUS_COLORS,
  formatDateRange,
  type Activity,
} from "../types";
import { ItinerarySection } from "./ItinerarySection";
import { TodayCard } from "./TodayCard";
import { isTripActive } from "../types";
import { ItineraryMap, type DayRouteInfo } from "./ItineraryMap";
import { ActivityList } from "./ActivityList";
import { ReadinessDashboard } from "./ReadinessDashboard";
import { TripChecklist } from "./TripChecklist";
import { ProposalsTab } from "./ProposalsTab";
import { JournalTab } from "./JournalTab";

const TwoColumn = styled.div`
  display: grid;
  grid-template-columns: 400px 1fr;
  gap: 12px;
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
  const [routeInfo, setRouteInfo] = useState<DayRouteInfo>({});
  const [activeTabState, setActiveTabState] = useState<string | null>(null);

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
        <BackLink onClick={() => navigate("..")}>
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
    navigate("..");
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
      <BackLink onClick={() => navigate("..")}>
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

      {isTripActive(trip, new Date()) && activeItin && (
        <TodayCard
          trip={trip}
          itinerary={activeItin}
          activityMap={activityMap}
          onOpenDay={(idx) => {
            setFocusDay(idx);
            setActiveTabState("itinerary");
          }}
        />
      )}

      {(() => {
        const showReadiness = trip.status === "Booked" || trip.status === "Ongoing" || trip.status === "Researching";
        const showJournal = trip.status === "Ongoing" || trip.status === "Completed";
        const defaultTab = showJournal && trip.status === "Completed"
          ? "journal"
          : itineraries.length > 0 ? "itinerary" : "proposals";
        const hasMap = hasMapData && activeItin;

        const tabItems = [
          {
            key: "proposals",
            label: <span><InboxOutlined /> Proposals</span>,
            children: <ProposalsTab tripId={trip.id} activityMap={activityMap} />,
          },
          {
            key: "itinerary",
            label: <span><ScheduleOutlined /> Itinerary</span>,
            children: itineraries.length > 0 ? (
              <ItinerarySection
                itineraries={itineraries}
                activityMap={activityMap}
                focusDay={focusDay}
                routeInfo={routeInfo}
                onDayClick={(day) => setFocusDay(focusDay === day ? null : day)}
                onDayNav={(day) => setFocusDay(day)}
                navigate={navigate}
              />
            ) : <Empty description="No itinerary yet" />,
          },
          {
            key: "activities",
            label: <span><UnorderedListOutlined /> Activities ({activities.length})</span>,
            children: (
              <ActivityList
                activities={activities}
                showReflection={trip.status === "Ongoing" || trip.status === "Completed"}
              />
            ),
          },
          ...(showJournal ? [{
            key: "journal",
            label: <span><BookOutlined /> Journal</span>,
            children: (
              <JournalTab
                trip={trip}
                logId={state.log?.id ?? ""}
                activeItinerary={activeItin}
                activityMap={activityMap}
              />
            ),
          }] : []),
          {
            key: "prep",
            label: <span><CheckSquareOutlined /> Prep</span>,
            children: (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {showReadiness && (
                  <>
                    <ReadinessDashboard trip={trip} activities={activities} itineraries={itineraries} />
                    <TripChecklist trip={trip} />
                  </>
                )}
                {trip.notes && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500, color: "#8c8c8c", marginBottom: 4 }}>NOTES</div>
                    <NotesCard>{trip.notes}</NotesCard>
                  </div>
                )}
                {sourceRefLines.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500, color: "#8c8c8c", marginBottom: 4 }}>
                      SOURCES ({sourceRefLines.length})
                    </div>
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
                  </div>
                )}
                {!showReadiness && !trip.notes && sourceRefLines.length === 0 && (
                  <Empty description="Nothing to prep yet" />
                )}
              </div>
            ),
          },
        ];

        const activeTab = activeTabState ?? defaultTab;
        const setActiveTab = setActiveTabState;

        return (
          <TwoColumn>
            {hasMap && activeTab === "itinerary" ? (
              <StickyMap>
                <ItineraryMap
                  itinerary={activeItin}
                  activities={activities}
                  activityMap={activityMap}
                  focusDay={focusDay}
                  onRouteInfo={(info) => setRouteInfo(prev => ({ ...prev, ...info }))}
                />
              </StickyMap>
            ) : (
              <div />
            )}
            <div>
              <Tabs
                activeKey={activeTab}
                onChange={setActiveTab}
                items={tabItems}
                defaultActiveKey={defaultTab}
                size="small"
              />
            </div>
          </TwoColumn>
        );
      })()}
    </WideContainer>
  );
}
