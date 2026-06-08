/**
 * Full-page view of a single itinerary day.
 *
 * Mounted at `:tripId/day/:date` (date is YYYY-MM-DD). Replaces the inline
 * "expanded day" mode that used to live inside the Itinerary tab and forced
 * users to scroll past the trip header to find it. Day push notifications
 * deep-link here. Each day has its own URL.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeftOutlined,
  CarOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  DollarOutlined,
  EnvironmentOutlined,
  HomeOutlined,
  LeftOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { Button, Empty, Popconfirm, Spin } from "antd";
import styled from "styled-components";
import { useTravelBackend, WideContainer, useUrlParam } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { getActivitiesForTrip, getItinerariesForTrip, mapsUrl } from "../utils";
import {
  calculateDayLoad,
  formatSlotTime,
  isTripActive,
  localYmd,
  parseSlotTime,
  validateDay,
  type Activity,
  type DayLoad,
} from "../types";
import { ActivityReflection, DayJournal, isDayReflectable } from "./InlineReflection";
import { ItineraryMap, type DayRouteInfo } from "./ItineraryMap";
import { hikeSummary } from "./ActivityList";
import { useSelectedItinerary } from "../hooks/useSelectedItinerary";
import { useTripWeather, weatherByDate as buildWeatherByDate } from "../hooks/useTripWeather";
import { useDayHourlyWeather } from "../hooks/useDayHourlyWeather";
import { useHorizontalSwipe } from "../hooks/useHorizontalSwipe";
import { WeatherBadge } from "./WeatherBadge";
import { HourWeather } from "./HourWeather";

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
  top: var(--app-header-height);

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

// Dedicated day-navigation row. Never wraps: arrows are edge-pinned and the
// center title block absorbs all flex/overflow, so the Prev/Next controls can
// never be pushed off-screen (the bug this layout fixes — users couldn't tell
// a next day existed). Metadata badges live in the separate DayMeta row below.
const DayNav = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: nowrap;
  gap: 8px;
`;

const DayNavCenter = styled.div`
  flex: 1;
  min-width: 0;
  text-align: center;
`;

// Real, tappable nav control (not the prior icon-only text button that
// visually vanished). Bordered chevron + label, comfortable touch height.
const NavButton = styled.button`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #fff;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  color: #595959;
  cursor: pointer;
  padding: 6px 12px;
  font-size: 14px;
  line-height: 1;

  &:hover:not(:disabled) { color: #1677ff; border-color: #1677ff; }
  &:active:not(:disabled) { background: #f0f0f0; }
  &:disabled { color: #bfbfbf; border-color: #f0f0f0; opacity: 0.6; cursor: default; }

  @media (max-width: 600px) {
    min-height: 44px;
    padding: 0 12px;
  }
`;

// Secondary metadata row — demoted from the old overloaded header. Allowed to
// wrap freely now that it no longer competes with the nav arrows.
const DayMeta = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding-bottom: 8px;
  margin: 8px 0 12px;
  border-bottom: 1px solid #f0f0f0;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 20px;
  font-weight: 600;
`;

// Single line, ellipsis-truncated — `day.label` can be long ("Day 2 — Sun Sep
// 8: Zion Narrows") and must never force the nav row to grow and shove the
// arrows off-screen. Full text is available via the title attribute.
const SubTitle = styled.div`
  color: #8c8c8c;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

// Wraps the swipe-handler region. `touch-action: pan-y` lets the browser own
// vertical scrolling while our handler owns horizontal intent, so a lazy
// diagonal drag can't both scroll the page AND flip the day.
const SwipeContainer = styled.div`
  touch-action: pan-y;
`;

// Subtle "days are swipeable" affordance for touch — muted, centered, small.
const SwipeHint = styled.div`
  display: none;
  text-align: center;
  color: #bfbfbf;
  font-size: 11px;
  margin-bottom: 8px;

  @media (max-width: 600px) {
    display: block;
  }
`;

// Each slot is a distinct card so activities read as separate blocks rather
// than one undifferentiated wall. Desktop: a 3-column grid (time gutter |
// content | actions). Phone (<=600px): time + actions share the top row,
// content reflows full-width beneath. `$flight` slots render only time +
// content (no actions child), so they drop the dangling `auto` actions track.
// `$clickable` rows navigate to the activity detail view on tap.
const Slot = styled.div<{ $flight?: boolean; $clickable?: boolean }>`
  display: grid;
  grid-template-columns: ${(p) => (p.$flight ? "64px 1fr" : "64px 1fr auto")};
  grid-template-areas: ${(p) => (p.$flight ? '"time content"' : '"time content actions"')};
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fff;
  align-items: flex-start;
  cursor: ${(p) => (p.$clickable ? "pointer" : "default")};
  transition: background 0.12s, border-color 0.12s;
  &:hover { ${(p) => (p.$clickable ? "background: #fafafa; border-color: #e0e0e0;" : "")} }
  /* :active gives touch devices the pressed feedback they otherwise lack —
     iOS has no hover, so tap-to-detail would be invisible without it. */
  &:active { ${(p) => (p.$clickable ? "background: #f0f0f0;" : "")} }

  @media (max-width: 600px) {
    grid-template-columns: ${(p) => (p.$flight ? "1fr" : "1fr auto")};
    grid-template-areas: ${(p) =>
      p.$flight
        ? '"time" "content"'
        : '"time actions" "content content"'};
    column-gap: 8px;
    row-gap: 4px;
  }
`;

// Time gutter: the slot's start time stacked above its per-activity weather.
const SlotTime = styled.div`
  grid-area: time;
  color: #1677ff;
  font-size: 12px;
  font-weight: 500;
  min-width: 64px;
  padding-top: 2px;
  display: flex;
  flex-direction: column;
  gap: 2px;

  @media (max-width: 600px) {
    min-width: 0;
    flex-direction: row;
    align-items: center;
    gap: 6px;
  }
`;

// Content region: photo + body sit side by side (own little flex row) so they
// can flow full-width under the time/actions row on phones.
const SlotContent = styled.div`
  grid-area: content;
  display: flex;
  gap: 10px;
  min-width: 0;
`;

// Action button (delete). Visually small on desktop; padded up to a
// comfortable 44px touch target on phones — it's an isolated destructive
// button, so the target honors the touch-guideline minimum.
const SlotActions = styled.div`
  grid-area: actions;
  @media (max-width: 600px) {
    .ant-btn {
      min-width: 44px;
      min-height: 44px;
    }
  }
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
  font-size: 15px;
  font-weight: 600;
  color: #262626;
`;

// Trailing chevron on tappable activity cards — the "this opens a detail view"
// affordance. Touch has no hover, so without this the card gives no cue it's
// interactive. Muted so it reads as a hint, not a button.
const SlotChevron = styled(RightOutlined)`
  color: #bfbfbf;
  font-size: 12px;
  margin-left: 4px;
  flex-shrink: 0;
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

// One-to-two-line truncated description on the day card.
const SlotDescClamp = styled(SlotDesc)`
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
`;

// Per-placement note ("how this fits THIS day"), visually distinct from the
// activity's intrinsic description.
const DayNote = styled.div`
  font-size: 12px;
  color: #595959;
  margin-top: 4px;
  padding: 4px 8px;
  background: #f6f8fa;
  border-left: 3px solid #d0d7de;
  border-radius: 0 4px 4px 0;
`;

const DayNoteLabel = styled.span`
  font-weight: 600;
  color: #8c8c8c;
  margin-right: 4px;
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

  /* The 64px indent aligns under the desktop content gutter; on phones the
     gutter is gone, so a small indent reads better. */
  @media (max-width: 600px) {
    padding-left: 10px;
  }
`;

// ── Component ───────────────────────────────────────────────────

export function DayView() {
  const { tripId, date } = useParams<{ tripId: string; date: string }>();
  const navigate = useNavigate();
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

  const itinerary = useSelectedItinerary(itineraries);

  // Keep `?itin=` in sync with the resolved itinerary. useSelectedItinerary
  // silently falls back to the active/first itinerary when the URL holds a
  // stale id (e.g. after deletion); without this, a refresh on a stale
  // `?itin=<deleted-id>` URL renders fine but the URL keeps lying about which
  // itinerary is selected, so subsequent reads and back/forward drift apart.
  // Mirrors the same pattern in ItinerarySection (Bundle 3c).
  const [selectedItinParam, setSelectedItin] = useUrlParam<string | null>("itin", {
    parse: (raw) => raw,
    serialize: (v) => v,
    default: null,
  });
  useEffect(() => {
    if (!itinerary) return;
    if (selectedItinParam === itinerary.id) return;
    setSelectedItin(itinerary.id);
  }, [itinerary, selectedItinParam, setSelectedItin]);

  const [routeInfo, setRouteInfo] = useState<DayRouteInfo>({});

  // Per-day weather (shared API cache with the trip detail view).
  const weather = useTripWeather(tripId);
  const weatherByDate = useMemo(() => buildWeatherByDate(weather.data), [weather.data]);

  // Activity ids on this day (slots + flights) — each gets weather at its OWN
  // location, so a day spanning timezones renders each slot in its local hours.
  const dayActivityIds = useMemo(() => {
    if (!itinerary) return [];
    const d = itinerary.days.find((x) => x.date === date);
    if (!d) return [];
    return [...(d.flights ?? []), ...d.slots].map((s) => s.activityId).filter(Boolean);
  }, [itinerary, date]);

  // Hourly weather for THIS day's activities, for the per-activity indicator.
  const { pickForActivity } = useDayHourlyWeather(tripId, date, dayActivityIds);

  // Swipe left → next day, swipe right → prev day. Computed here (before the
  // early returns) so the hook is called unconditionally; the prev/next dates
  // are resolved from the same itinerary/day data the render uses below. A
  // no-op when the target day doesn't exist.
  const swipeNav = useMemo(() => {
    if (!itinerary) return { prev: undefined as string | undefined, next: undefined as string | undefined };
    const i = itinerary.days.findIndex((d) => d.date === date);
    return {
      prev: i > 0 ? itinerary.days[i - 1].date : undefined,
      next: i >= 0 && i < itinerary.days.length - 1 ? itinerary.days[i + 1].date : undefined,
    };
  }, [itinerary, date]);
  // URL-relative ("../{d}") because we're already at /{tripId}/day/{date} —
  // `..` strips the date segment, then `{d}` puts us at /{tripId}/day/{d}.
  // Default route-relative resolution would walk up matched routes instead
  // and produce the wrong path for these flat routes.
  // `replace: true` because prev/next is a "scrubbing" interaction, not a
  // "navigate" one — a single back press should escape the whole DayView
  // rather than walk back through every day the user paged through.
  // `preserveScroll` so day↔day feels like an in-page content swap, not a
  // fresh page nav — ScrollRestoration honors the flag and leaves the scroll
  // alone. Fresh entries to a day (deep link, notification, itinerary list)
  // carry no flag, so they still start at the top.
  const navToDate = (d?: string) => {
    if (!d) return;
    navigate(`../${d}`, { relative: "path", replace: true, state: { preserveScroll: true } });
  };
  const swipeHandlers = useHorizontalSwipe({
    onSwipeLeft: () => navToDate(swipeNav.next),
    onSwipeRight: () => navToDate(swipeNav.prev),
  });

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
  // prev/next dates already resolved in `swipeNav` above (shared with the
  // swipe gesture). The nav buttons and the swipe target off the same data.
  const { prev: prevDate, next: nextDate } = swipeNav;
  const hasPrev = !!prevDate;
  const hasNext = !!nextDate;
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

        <SwipeContainer {...swipeHandlers}>
          <DayNav>
            <NavButton
              disabled={!hasPrev}
              onClick={() => navToDate(prevDate)}
              title="Previous day"
            >
              <LeftOutlined /> Prev
            </NavButton>
            <DayNavCenter>
              <Title>Day {dayIndex + 1} / {totalDays}</Title>
              <SubTitle title={day.label || dateLabel}>{day.label || dateLabel}</SubTitle>
            </DayNavCenter>
            <NavButton
              disabled={!hasNext}
              onClick={() => navToDate(nextDate)}
              title="Next day"
            >
              Next <RightOutlined />
            </NavButton>
          </DayNav>

          {(hasPrev || hasNext) && (
            <SwipeHint>
              {`${hasPrev ? "‹ " : ""}swipe to change day${hasNext ? " ›" : ""}`}
            </SwipeHint>
          )}

          <DayMeta>
            {day.date && weatherByDate.get(day.date) && (
              <WeatherBadge day={weatherByDate.get(day.date)!} />
            )}
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
          </DayMeta>

          {flights.map((f, j) => {
            const timeStr = formatSlotTime(f.startTime);
            const hour = parseSlotTime(f.startTime) != null ? pickForActivity(f.activityId, f.startTime) : null;
            const clickable = !!f.activity;
            return (
              <Slot
                key={`f-${j}`}
                $flight
                $clickable={clickable}
                onClick={clickable ? () => navigate(`../../activities/${f.activityId}`, { relative: "path" }) : undefined}
              >
                <SlotTime>
                  <span>{timeStr}</span>
                  {hour && <HourWeather hour={hour} />}
                </SlotTime>
                <SlotContent>
                  <SlotBody>
                    <SlotName style={{ color: "#1677ff" }}>{"✈"} {f.activity?.name || f.activityId}</SlotName>
                    {f.activity?.description && <SlotDescClamp>{f.activity.description}</SlotDescClamp>}
                    {f.dayNote && (
                      <DayNote><DayNoteLabel>For this day:</DayNoteLabel>{f.dayNote}</DayNote>
                    )}
                    {f.activity?.confirmationCode && (
                      <SlotMeta>
                        <ConfCode
                          onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(f.activity!.confirmationCode); }}
                          title="Click to copy"
                        >
                          {f.activity.confirmationCode}
                        </ConfCode>
                      </SlotMeta>
                    )}
                  </SlotBody>
                </SlotContent>
              </Slot>
            );
          })}

          {day.slots.flatMap((slot, j) => {
            const activity = activityMap.get(slot.activityId);
            const actUrl = activity ? mapsUrl(activity) : null;
            // Look up "the drive arriving at slot j" by slot index, not by
            // positional offset into legs — flights, missing-coords slots,
            // and lodging bookends shift positional indices.
            const leg = ri?.legMap?.legBySlotIndex.get(j);
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
            const timeStr = formatSlotTime(slot.startTime);
            const hour = parseSlotTime(slot.startTime) != null ? pickForActivity(slot.activityId, slot.startTime) : null;
            const clickable = !!activity;
            elements.push(
              <Slot
                key={j}
                $clickable={clickable}
                onClick={clickable ? () => navigate(`../../activities/${activity!.id}`, { relative: "path" }) : undefined}
              >
                <SlotTime>
                  <span>{timeStr}</span>
                  {hour && <HourWeather hour={hour} />}
                </SlotTime>
                <SlotContent>
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
                      <ExternalLink href={actUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#8c8c8c", marginLeft: 4, fontSize: 11 }}>
                        <EnvironmentOutlined />
                      </ExternalLink>
                    )}
                    {clickable && <SlotChevron />}
                  </SlotName>
                  <SlotMeta>
                    {activity?.rating != null && <span style={{ color: "#fa8c16" }}>&#9733;{activity.rating}</span>}
                    {activity?.location && (
                      <ExternalLink href={`https://www.google.com/maps/search/${encodeURIComponent(activity.location)}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#8c8c8c" }}>
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
                  {activity?.description && <SlotDescClamp style={{ fontStyle: "italic" }}>{activity.description}</SlotDescClamp>}
                  {slot.dayNote && (
                    <DayNote><DayNoteLabel>For this day:</DayNoteLabel>{slot.dayNote}</DayNote>
                  )}
                  {dayReflectable && activity && activity.category !== "Flight" && (
                    <div onClick={(e) => e.stopPropagation()}>
                      <ActivityReflection activity={activity} />
                    </div>
                  )}
                </SlotBody>
                </SlotContent>
                <SlotActions onClick={(e) => e.stopPropagation()}>
                  <Popconfirm title="Remove from this day?" onConfirm={() => removeSlot(j)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} title="Remove from this day" />
                  </Popconfirm>
                </SlotActions>
              </Slot>,
            );
            return elements;
          })}

          {(() => {
            // "Last leg" is the drive from the final slot/stop back to today's
            // lodging. The helper labels this explicitly as `end-lodging` so
            // we no longer have to guess by `day.slots.length`.
            const lastLeg = ri?.legMap?.endLodgingLeg;
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
            <DayJournal tripId={trip.id} date={day.date} />
          )}
        </SwipeContainer>
      </TwoColumn>
    </WideContainer>
  );
}
