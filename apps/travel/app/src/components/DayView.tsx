/**
 * Full-page view of an itinerary, one day at a time.
 *
 * Mounted at `:tripId/day/:date` (date is YYYY-MM-DD). Day push notifications
 * deep-link here; each day still has its own shareable URL. Internally this is
 * a single mounted view: an Embla horizontal carousel holds ALL days, so
 * swiping/dragging between days never re-routes or remounts (the route-nav
 * model used to reset scroll on every day change). The embedded map sits
 * OUTSIDE the carousel and refocuses reactively as the active day changes.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import useEmblaCarousel from "embla-carousel-react";
import AutoHeight from "embla-carousel-auto-height";
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
  type ItineraryDay,
} from "../types";
import { ActivityReflection, DayJournal, isDayReflectable } from "./InlineReflection";
import { ItineraryMap, type DayRouteInfo } from "./ItineraryMap";
import { hikeSummary } from "./ActivityList";
import { useSelectedItinerary } from "../hooks/useSelectedItinerary";
import { useTripWeather, weatherByDate as buildWeatherByDate, type WeatherDay } from "../hooks/useTripWeather";
import { useDayHourlyWeather } from "../hooks/useDayHourlyWeather";
import { WeatherBadge } from "./WeatherBadge";
import { HourWeather } from "./HourWeather";

// ── Layout ──────────────────────────────────────────────────────

const TwoColumn = styled.div`
  display: grid;
  grid-template-columns: 400px 1fr;
  gap: 12px;
  align-items: start;

  /* Grid 1fr is minmax(auto, 1fr); the auto min lets a child expand past the
     track. Floor every grid item at 0 so a wide child (the Embla track,
     N x 100% slides) shrinks to the column width instead of blowing it out. */
  > * {
    min-width: 0;
  }

  @media (max-width: 1000px) {
    grid-template-columns: 1fr;
  }
`;

// The content column. min-width:0 is load-bearing: without it this grid item
// keeps its default `min-width: auto` and refuses to shrink below the intrinsic
// width of the Embla flex track (N slides × 100%), blowing the `1fr` column
// wider than the viewport and shoving the Next arrow + slides off the right
// edge. max-width:100% is a belt against any residual overflow.
const ContentCol = styled.div`
  min-width: 0;
  max-width: 100%;
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

// ── Embla carousel ──────────────────────────────────────────────
// The track is the day content. Each slide is a single day. AutoHeight makes
// the viewport take the active slide's height so the page scrolls vertically
// for long days — no nested scroll container (which would block page scroll).
const Viewport = styled.div`
  width: 100%;
  overflow: hidden;
  /* Embla JS owns the horizontal drag; with AutoHeight this surface overlaps a
     long day's full vertical-scroll region. Without this hint iOS Safari
     evaluates each gesture both ways → juddery vertical scroll + diagonal-flick
     day changes. pan-y/pinch-zoom = vertical scroll + pinch are native, only
     horizontal is Embla's. (Matches apps/life/.../LifeDashboard.tsx.) */
  touch-action: pan-y pinch-zoom;
`;

const Track = styled.div`
  display: flex;
  /* AutoHeight animates the viewport to the active slide's height. */
  align-items: flex-start;
`;

// Each slide must be full-width and not shrink. min-width:0 lets inner content
// truncate instead of forcing the slide wider than the viewport.
const Slide = styled.div`
  flex: 0 0 100%;
  min-width: 0;
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

// ── Per-day content slide ───────────────────────────────────────

interface DaySlideProps {
  trip: { id: string };
  day: ItineraryDay;
  dayIndex: number;
  /** True only while this slide is at/near the active index (in-view ±1). Gates
   *  photo rendering so a 34-day trip doesn't fetch hundreds of Google photos. */
  active: boolean;
  activityMap: globalThis.Map<string, Activity>;
  routeInfo: DayRouteInfo;
  weatherByDate: globalThis.Map<string, WeatherDay>;
  pickForActivity: ReturnType<typeof useDayHourlyWeather>["pickForActivity"];
  dayReflectable: boolean;
  apiKey: string;
  onNavigate: (path: string) => void;
  onRemoveSlot: (dayIndex: number, slotIndex: number) => void;
}

function DaySlide({
  trip,
  day,
  dayIndex,
  active,
  activityMap,
  routeInfo,
  weatherByDate,
  pickForActivity,
  dayReflectable,
  apiKey,
  onNavigate,
  onRemoveSlot,
}: DaySlideProps) {
  const lodging = day.lodgingActivityId ? activityMap.get(day.lodgingActivityId) : null;
  const flights = (day.flights || []).map((f) => ({ ...f, activity: activityMap.get(f.activityId) }));
  const slotActivities = day.slots
    .map((s) => activityMap.get(s.activityId))
    .filter((a): a is Activity => a != null);
  const load = calculateDayLoad(slotActivities);
  const issues = validateDay(day.slots, activityMap);
  const ri = routeInfo[dayIndex];

  return (
    <>
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
            onClick={clickable ? () => onNavigate(`../../activities/${f.activityId}`) : undefined}
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
            onClick={clickable ? () => onNavigate(`../../activities/${activity!.id}`) : undefined}
          >
            <SlotTime>
              <span>{timeStr}</span>
              {hour && <HourWeather hour={hour} />}
            </SlotTime>
            <SlotContent>
            {/* Gate photo fetch to in-view (±1) slides so long trips don't
                request hundreds of Google photo URLs on mount. `loading="lazy"`
                is belt-and-suspenders for the active slides themselves. */}
            {activity?.photoRef && active && (
              <SlotPhoto
                src={`https://places.googleapis.com/v1/${activity.photoRef}/media?maxWidthPx=120&key=${apiKey}`}
                alt={activity.name}
                loading="lazy"
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
              <Popconfirm title="Remove from this day?" onConfirm={() => onRemoveSlot(dayIndex, j)}>
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
    </>
  );
}

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

  const days = useMemo(() => itinerary?.days ?? [], [itinerary]);
  const urlIndex = useMemo(() => days.findIndex((d) => d.date === date), [days, date]);

  // The carousel's active day. Initialized to the mounted URL date (or 0); kept
  // in sync via Embla's `select`. The map's focusDay and the header read this —
  // NOT the URL — so swiping changes both with no route remount.
  const [activeIndex, setActiveIndex] = useState(() => (urlIndex >= 0 ? urlIndex : 0));
  // In-view slide indices (for gating heavy photo fetches on long trips). Seeded
  // with the start slide ±1 so the first neighbor preloads before Embla's first
  // slidesInView fires; replaced by the ±1-expanded handler once Embla is live.
  const [inView, setInView] = useState<Set<number>>(() => {
    const start = urlIndex >= 0 ? urlIndex : 0;
    return new Set([start - 1, start, start + 1].filter((i) => i >= 0));
  });

  // Hourly weather for the ACTIVE day's activities, for the per-activity
  // indicator. Keyed to the active day's date (not the URL's) so it tracks
  // swipes; a no-op when there's no itinerary/day.
  const activeDate = days[activeIndex]?.date;
  const dayActivityIds = useMemo(() => {
    const d = days[activeIndex];
    if (!d) return [];
    return [...(d.flights ?? []), ...d.slots].map((s) => s.activityId).filter(Boolean);
  }, [days, activeIndex]);
  const { pickForActivity } = useDayHourlyWeather(tripId, activeDate, dayActivityIds);

  // Stable options + plugins so a URL change never churns the options object
  // and forces a reInit mid-swipe. We deliberately DON'T use Embla's
  // `startIndex` — the viewport only mounts after the loading gate clears, by
  // which point a frozen option would carry the wrong (pre-data) index. Instead
  // the init effect below jumps instantly to the mounted URL date.
  const emblaOptions = useMemo(() => ({ loop: false, align: "start" as const }), []);
  const emblaPlugins = useMemo(() => [AutoHeight()], []);
  const [emblaRef, emblaApi] = useEmblaCarousel(emblaOptions, emblaPlugins);
  // Pin the initial slide once Embla is live (instant jump, no animation). Guard
  // so it only runs on first init, not on every later urlIndex change.
  const didInitRef = useRef(false);

  // We navigate the URL to mirror the active slide. To distinguish "user/back
  // button changed the URL" from "our own select→navigate echo", we record the
  // date we last pushed. The URL→Embla sync effect ignores the URL when it
  // matches that echo, so it never bounces the active slide back.
  const selfNavDateRef = useRef<string | undefined>(date);

  // Embla → state + URL. On every settle, sync the active index, then mirror
  // the date into the URL (replace, preserveScroll) so deep-links / back-fwd /
  // shareable URLs keep working. Guarded so this never remounts the carousel.
  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => {
      const i = emblaApi.selectedScrollSnap();
      setActiveIndex(i);
      const d = days[i]?.date;
      if (d && d !== selfNavDateRef.current) {
        selfNavDateRef.current = d;
        navigate(`../${d}`, { relative: "path", replace: true, state: { preserveScroll: true } });
      }
    };
    // Expand the actually-visible set by ±1 so the neighbor you're about to
    // swipe to has its photos already fetched (slidesInView() alone pops them
    // in late). Clamped to bounds; still bounded so a 34-day trip never fetches
    // all days' photos.
    const onSlidesInView = () => {
      const expanded = new Set<number>();
      for (const i of emblaApi.slidesInView()) {
        if (i > 0) expanded.add(i - 1);
        expanded.add(i);
        if (i < days.length - 1) expanded.add(i + 1);
      }
      setInView(expanded);
    };
    emblaApi.on("select", onSelect);
    emblaApi.on("slidesInView", onSlidesInView);
    // On the FIRST live init, jump instantly to the mounted URL date so a
    // deep-link to day 5 opens there. Done before seeding so the seed reads the
    // correct snap (and doesn't navigate day 0 over the URL). The instant jump
    // emits no `select`, so we seed manually after.
    if (!didInitRef.current) {
      didInitRef.current = true;
      if (urlIndex >= 0 && emblaApi.selectedScrollSnap() !== urlIndex) {
        emblaApi.scrollTo(urlIndex, true);
      }
    }
    // Seed once on mount/reInit so AutoHeight and inView reflect the start slide.
    onSelect();
    onSlidesInView();
    return () => {
      emblaApi.off("select", onSelect);
      emblaApi.off("slidesInView", onSlidesInView);
    };
    // urlIndex intentionally excluded — this effect is the one-time init; later
    // URL changes are handled by the URL→Embla effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emblaApi, days, navigate]);

  // URL → Embla. Only fires when the URL date changed EXTERNALLY (back/forward,
  // a fresh deep-link, notification) — i.e. not as an echo of our own select.
  // Without the `selfNavDateRef` guard this would fight the select handler and
  // bounce the slide back.
  useEffect(() => {
    if (!emblaApi || urlIndex < 0) return;
    if (date === selfNavDateRef.current) return; // our own echo — ignore
    selfNavDateRef.current = date;
    if (emblaApi.selectedScrollSnap() !== urlIndex) emblaApi.scrollTo(urlIndex, true);
  }, [emblaApi, urlIndex, date]);

  // Clamp the active index when the day count shrinks (a day removed while
  // viewing, or the itinerary swapped). Otherwise activeIndex can point past
  // the new slide count → days[activeIndex] undefined, off-by-one header, and
  // an out-of-range map focusDay. Snap Embla to the clamped index too so the
  // carousel and state agree.
  useEffect(() => {
    if (days.length > 0 && activeIndex >= days.length) {
      const clamped = days.length - 1;
      setActiveIndex(clamped);
      if (emblaApi && emblaApi.selectedScrollSnap() !== clamped) emblaApi.scrollTo(clamped, true);
    }
  }, [days.length, activeIndex, emblaApi]);

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

  // Stale/invalid `:date` deep-link → keep the empty state; do NOT auto-jump to
  // day 0. This early return runs before the <Viewport ref={emblaRef}> below
  // mounts, so emblaApi stays null and the init effect (which would otherwise
  // seed-navigate to day 0) short-circuits on `if (!emblaApi) return`. No
  // parasitic day-0 navigate fires.
  if (urlIndex < 0) {
    return (
      <WideContainer>
        <BackLink onClick={() => navigate("../..", { relative: "path" })}>
          <ArrowLeftOutlined /> Back to {trip.destination}
        </BackLink>
        <Empty description={`No day "${date}" on this itinerary`} style={{ marginTop: 40 }} />
      </WideContainer>
    );
  }

  const totalDays = days.length;
  const activeDay = days[activeIndex];
  const hasPrev = activeIndex > 0;
  const hasNext = activeIndex < totalDays - 1;
  const hasMapData = activities.some((a) => a.lat != null && a.lng != null);

  const removeSlot = (dayIndex: number, slotIndex: number) => {
    const newDays = days.map((d, i) =>
      i === dayIndex ? { ...d, slots: d.slots.filter((_, k) => k !== slotIndex) } : d,
    );
    return travel.setItineraryDays(itinerary.id, newDays);
  };

  const todayYmd = localYmd(new Date());
  const tripHasStarted =
    trip.status === "Ongoing" ||
    trip.status === "Completed" ||
    isTripActive(trip, new Date()) ||
    (trip.startDate != null && trip.startDate <= new Date());

  const dateLabel = (d: ItineraryDay) =>
    d.date
      ? new Date(d.date + "T12:00:00").toLocaleDateString("en-US", {
          weekday: "long",
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "";

  const activeLabel = activeDay.label || dateLabel(activeDay);

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
              focusDay={activeIndex}
              onRouteInfo={(info) => setRouteInfo((prev) => ({ ...prev, ...info }))}
            />
          </StickyMap>
        ) : (
          <div />
        )}

        <ContentCol>
          {/* Shared header — reflects the active day. Prev/Next drive Embla,
              not route nav. */}
          <DayNav>
            <NavButton
              disabled={!hasPrev}
              onClick={() => emblaApi?.scrollPrev()}
              title="Previous day"
            >
              <LeftOutlined /> Prev
            </NavButton>
            <DayNavCenter>
              <Title>Day {activeIndex + 1} / {totalDays}</Title>
              <SubTitle title={activeLabel}>{activeLabel}</SubTitle>
            </DayNavCenter>
            <NavButton
              disabled={!hasNext}
              onClick={() => emblaApi?.scrollNext()}
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

          <Viewport ref={emblaRef}>
            <Track>
              {days.map((d, i) => {
                const dayReflectable = tripHasStarted && isDayReflectable(d.date, todayYmd);
                return (
                  <Slide key={i}>
                    <DaySlide
                      trip={trip}
                      day={d}
                      dayIndex={i}
                      active={inView.has(i)}
                      activityMap={activityMap}
                      routeInfo={routeInfo}
                      weatherByDate={weatherByDate}
                      pickForActivity={pickForActivity}
                      dayReflectable={dayReflectable}
                      apiKey={apiKey}
                      onNavigate={(path) => navigate(path, { relative: "path" })}
                      onRemoveSlot={removeSlot}
                    />
                  </Slide>
                );
              })}
            </Track>
          </Viewport>
        </ContentCol>
      </TwoColumn>
    </WideContainer>
  );
}
