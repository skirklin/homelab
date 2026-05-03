/**
 * Full-page view of a single itinerary day.
 *
 * Mounted at `:tripId/day/:date` (date is YYYY-MM-DD). Replaces the inline
 * "expanded day" mode that used to live inside the Itinerary tab and forced
 * users to scroll past the trip header to find it. Day push notifications
 * deep-link here. Each day has its own URL.
 */
import React, { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeftOutlined,
  CarOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  DollarOutlined,
  EditOutlined,
  EnvironmentOutlined,
  HomeOutlined,
  LeftOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { Button, Empty, Popconfirm, Space, Spin } from "antd";
import styled from "styled-components";
import { useTravelBackend, WideContainer } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { getActivitiesForTrip, getItinerariesForTrip, mapsUrl } from "../utils";
import {
  calculateDayLoad,
  isTripActive,
  localYmd,
  validateDay,
  type Activity,
  type DayLoad,
} from "../types";
import { ActivityReflection, DayJournal, isDayReflectable } from "./InlineReflection";
import { ItineraryMap, type DayRouteInfo } from "./ItineraryMap";
import { hikeSummary } from "./ActivityList";

// ── Layout ──────────────────────────────────────────────────────

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

  &:hover { color: #595959; }
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-bottom: 8px;
  margin-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 20px;
  font-weight: 600;
`;

const SubTitle = styled.div`
  color: #8c8c8c;
  font-size: 13px;
`;

const Slot = styled.div`
  display: flex;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
  align-items: flex-start;
  &:last-child { border-bottom: none; }
`;

const SlotTime = styled.div`
  color: #1677ff;
  font-size: 12px;
  font-weight: 500;
  min-width: 64px;
  flex-shrink: 0;
  padding-top: 2px;
`;

const SlotPhoto = styled.img`
  width: 64px;
  height: 44px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
`;

const SlotBody = styled.div`
  flex: 1;
  min-width: 0;
`;

const SlotName = styled.div`
  font-size: 14px;
  font-weight: 500;
`;

const SlotMeta = styled.div`
  font-size: 12px;
  color: #8c8c8c;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
`;

const SlotDesc = styled.div`
  font-size: 12px;
  color: #595959;
  margin-top: 2px;
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
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #fa8c16;
  background: #fff7e6;
  border: 1px solid #ffd591;
  border-radius: 3px;
  padding: 1px 8px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const LOAD_COLORS: Record<DayLoad["level"], string> = {
  light: "#52c41a",
  moderate: "#1677ff",
  full: "#fa8c16",
  overpacked: "#ff4d4f",
};

const LoadBadge = styled.span<{ $level: DayLoad["level"] }>`
  font-size: 11px;
  font-weight: 600;
  color: ${(p) => LOAD_COLORS[p.$level]};
  background: ${(p) => LOAD_COLORS[p.$level]}15;
  border-radius: 3px;
  padding: 1px 6px;
  white-space: nowrap;
`;

const DriveTimeBadge = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #8c8c8c;
  padding: 4px 0 4px 64px;
`;

// ── Component ───────────────────────────────────────────────────

export function DayView() {
  const { tripId, date } = useParams<{ tripId: string; date: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { state } = useTravelContext();
  const travel = useTravelBackend();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiKey = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || "";

  const trip = tripId ? state.trips.get(tripId) : undefined;
  const activities = useMemo(
    () => (tripId ? getActivitiesForTrip(state.activities, tripId) : []),
    [state.activities, tripId],
  );
  const itineraries = useMemo(
    () => (tripId ? getItinerariesForTrip(state.itineraries, tripId) : []),
    [state.itineraries, tripId],
  );
  const activityMap = useMemo(() => {
    const m = new Map<string, Activity>();
    for (const a of activities) m.set(a.id, a);
    return m;
  }, [activities]);

  const selectedItinId = searchParams.get("itin");
  const itinerary = (selectedItinId
    ? itineraries.find((i) => i.id === selectedItinId)
    : null) ?? itineraries.find((i) => i.isActive) ?? itineraries[0];

  const [routeInfo, setRouteInfo] = useState<DayRouteInfo>({});

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
        <BackLink onClick={() => navigate("../..", { relative: "path" })}>
          <ArrowLeftOutlined /> Back
        </BackLink>
        <Empty description="Trip not found" style={{ marginTop: 40 }} />
      </WideContainer>
    );
  }

  if (!itinerary) {
    return (
      <WideContainer>
        <BackLink onClick={() => navigate("../..", { relative: "path" })}>
          <ArrowLeftOutlined /> Back to {trip.destination}
        </BackLink>
        <Empty description="No itinerary on this trip" style={{ marginTop: 40 }} />
      </WideContainer>
    );
  }

  const dayIndex = itinerary.days.findIndex((d) => d.date === date);
  if (dayIndex < 0) {
    return (
      <WideContainer>
        <BackLink onClick={() => navigate("../..", { relative: "path" })}>
          <ArrowLeftOutlined /> Back to {trip.destination}
        </BackLink>
        <Empty description={`No day "${date}" on this itinerary`} style={{ marginTop: 40 }} />
      </WideContainer>
    );
  }

  const day = itinerary.days[dayIndex];
  const totalDays = itinerary.days.length;
  const hasPrev = dayIndex > 0;
  const hasNext = dayIndex < totalDays - 1;
  const prevDate = hasPrev ? itinerary.days[dayIndex - 1].date : null;
  const nextDate = hasNext ? itinerary.days[dayIndex + 1].date : null;
  // URL-relative ("../{d}") because we're already at /{tripId}/day/{date} —
  // `..` strips the date segment, then `{d}` puts us at /{tripId}/day/{d}.
  // Default route-relative resolution would walk up matched routes instead
  // and produce the wrong path for these flat routes.
  const goToDay = (d?: string) => {
    if (!d) return;
    navigate(`../${d}`, { relative: "path" });
  };

  const lodging = day.lodgingActivityId ? activityMap.get(day.lodgingActivityId) : null;
  const flights = (day.flights || []).map((f) => ({ ...f, activity: activityMap.get(f.activityId) }));
  const slotActivities = day.slots
    .map((s) => activityMap.get(s.activityId))
    .filter((a): a is Activity => a != null);
  const load = calculateDayLoad(slotActivities);
  const issues = validateDay(day.slots, activityMap);
  const ri = routeInfo[dayIndex];

  const todayYmd = localYmd(new Date());
  const tripHasStarted =
    trip.status === "Ongoing" ||
    trip.status === "Completed" ||
    isTripActive(trip, new Date()) ||
    (trip.startDate != null && trip.startDate <= new Date());
  const dayReflectable = tripHasStarted && isDayReflectable(day.date, todayYmd);

  const hasMapData = activities.some((a) => a.lat != null && a.lng != null);

  const removeSlot = (slotIndex: number) => {
    const newDays = itinerary.days.map((d, i) =>
      i === dayIndex ? { ...d, slots: d.slots.filter((_, k) => k !== slotIndex) } : d,
    );
    return travel.setItineraryDays(itinerary.id, newDays);
  };

  const dateLabel = day.date
    ? new Date(day.date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

  return (
    <WideContainer>
      <BackLink onClick={() => navigate("..")}>
        <ArrowLeftOutlined /> Back to {trip.destination}
      </BackLink>

      <TwoColumn>
        {hasMapData ? (
          <StickyMap>
            <ItineraryMap
              itinerary={itinerary}
              activities={activities}
              activityMap={activityMap}
              focusDay={dayIndex}
              onRouteInfo={(info) => setRouteInfo((prev) => ({ ...prev, ...info }))}
            />
          </StickyMap>
        ) : (
          <div />
        )}

        <div>
          <Header>
            <Button
              type="text"
              icon={<LeftOutlined />}
              disabled={!hasPrev}
              onClick={() => goToDay(prevDate ?? undefined)}
              title="Previous day"
            />
            <div>
              <Title>Day {dayIndex + 1} / {totalDays}</Title>
              <SubTitle>{day.label || dateLabel}</SubTitle>
            </div>
            <Button
              type="text"
              icon={<RightOutlined />}
              disabled={!hasNext}
              onClick={() => goToDay(nextDate ?? undefined)}
              title="Next day"
            />
            {load.totalHours > 0 && (() => {
              const hasDriving = load.driveMiles > 5;
              const driveStr = ri
                ? `${Math.round(ri.durationMinutes / 60 * 10) / 10}h driving`
                : hasDriving ? "? driving" : "";
              return (
                <LoadBadge $level={load.level}>
                  {load.activityHours.toFixed(1)}h activities{driveStr ? ` + ${driveStr}` : ""}
                  {load.level === "overpacked" && " ⚠ overpacked"}
                </LoadBadge>
              );
            })()}
            {issues.length > 0 && (
              <span style={{ fontSize: 11, color: "#fa8c16" }} title={issues.map((i) => i.message).join("\n")}>
                {issues.length} issue{issues.length === 1 ? "" : "s"}
              </span>
            )}
            {lodging && (() => {
              const url = mapsUrl(lodging);
              return (
                <LodgingBadge as={url ? "a" : "span"} href={url || undefined} target="_blank" rel="noopener noreferrer">
                  <HomeOutlined /> {lodging.name}
                </LodgingBadge>
              );
            })()}
          </Header>

          {flights.map((f, j) => (
            <Slot key={`f-${j}`}>
              <SlotTime>{f.startTime || ""}</SlotTime>
              <SlotBody>
                <SlotName style={{ color: "#1677ff" }}>{"✈"} {f.activity?.name || f.activityId}</SlotName>
                {f.activity?.description && <SlotDesc>{f.activity.description}</SlotDesc>}
                {f.activity?.confirmationCode && (
                  <SlotMeta>
                    <ConfCode onClick={() => navigator.clipboard.writeText(f.activity!.confirmationCode)} title="Click to copy">
                      {f.activity.confirmationCode}
                    </ConfCode>
                  </SlotMeta>
                )}
              </SlotBody>
            </Slot>
          ))}

          {day.slots.flatMap((slot, j) => {
            const activity = activityMap.get(slot.activityId);
            const actUrl = activity ? mapsUrl(activity) : null;
            const leg = ri?.legs?.[j];
            const elements: React.ReactNode[] = [];
            if (leg && leg.durationMinutes > 0) {
              elements.push(
                <DriveTimeBadge key={`drive-${j}`}>
                  <CarOutlined />
                  {leg.durationMinutes < 60
                    ? `${leg.durationMinutes} min`
                    : `${(leg.durationMinutes / 60).toFixed(1)}h`}
                  {leg.distanceMiles > 0 && ` (${leg.distanceMiles} mi)`}
                </DriveTimeBadge>,
              );
            }
            elements.push(
              <Slot key={j}>
                <SlotTime>{slot.startTime || ""}</SlotTime>
                {activity?.photoRef && (
                  <SlotPhoto
                    src={`https://places.googleapis.com/v1/${activity.photoRef}/media?maxWidthPx=120&key=${apiKey}`}
                    alt={activity.name}
                  />
                )}
                <SlotBody>
                  <SlotName>
                    {activity?.category === "Hiking" && <span style={{ marginRight: 4 }}>🥾</span>}
                    {activity?.name || slot.activityId}
                    {actUrl && (
                      <ExternalLink href={actUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#8c8c8c", marginLeft: 4, fontSize: 11 }}>
                        <EnvironmentOutlined />
                      </ExternalLink>
                    )}
                  </SlotName>
                  <SlotMeta>
                    {activity?.rating != null && <span style={{ color: "#fa8c16" }}>&#9733;{activity.rating}</span>}
                    {activity?.location && (
                      <ExternalLink href={`https://www.google.com/maps/search/${encodeURIComponent(activity.location)}`} target="_blank" rel="noopener noreferrer" style={{ color: "#8c8c8c" }}>
                        {activity.location}
                      </ExternalLink>
                    )}
                    {activity?.durationEstimate && <span><ClockCircleOutlined /> {activity.durationEstimate}</span>}
                    {activity?.costNotes && <span><DollarOutlined /> {activity.costNotes}</span>}
                  </SlotMeta>
                  {activity?.category === "Hiking" && (() => {
                    const line = hikeSummary(activity);
                    return line ? <SlotDesc style={{ fontWeight: 500 }}>{line}</SlotDesc> : null;
                  })()}
                  {activity?.description && <SlotDesc style={{ fontStyle: "italic" }}>{activity.description}</SlotDesc>}
                  {activity?.details && <SlotDesc style={{ whiteSpace: "pre-wrap" }}>{activity.details}</SlotDesc>}
                  {slot.notes && <SlotDesc style={{ fontStyle: "italic", color: "#8c8c8c" }}>{slot.notes}</SlotDesc>}
                  {dayReflectable && activity && activity.category !== "Flight" && (
                    <ActivityReflection activity={activity} variant="compact" />
                  )}
                </SlotBody>
                <Space size={2} style={{ flexShrink: 0, alignSelf: "flex-start", paddingTop: 2 }}>
                  <Button type="text" size="small" icon={<EditOutlined />}
                    onClick={() => activity && navigate(`../../activities/${activity.id}/edit`, { relative: "path" })} />
                  <Popconfirm title="Remove from this day?" onConfirm={() => removeSlot(j)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              </Slot>,
            );
            return elements;
          })}

          {(() => {
            const lastLeg = ri?.legs?.[day.slots.length];
            if (!lastLeg || lastLeg.durationMinutes <= 0) return null;
            return (
              <DriveTimeBadge>
                <CarOutlined />
                {lastLeg.durationMinutes < 60
                  ? `${lastLeg.durationMinutes} min`
                  : `${(lastLeg.durationMinutes / 60).toFixed(1)}h`}
                {lastLeg.distanceMiles > 0 && ` (${lastLeg.distanceMiles} mi)`}
                {" to lodging"}
              </DriveTimeBadge>
            );
          })()}

          {dayReflectable && day.date && (
            <DayJournal tripId={trip.id} logId={state.log?.id ?? ""} date={day.date} />
          )}
        </div>
      </TwoColumn>
    </WideContainer>
  );
}
