/**
 * Prominent "today" card for active trips — shown at the top of TripDetail
 * while the trip is in progress. Surfaces the current day's scheduled slots
 * with a highlight on whatever's happening now and a countdown to the next
 * thing up.
 *
 * Rendered only when:
 *   - isTripActive(trip, now) — today falls within [startDate, endDate]
 *   - findTodayDay(itinerary, now) — an itinerary day matches today's date
 */
import { useEffect, useState, type ReactElement } from "react";
import { Tag } from "antd";
import { EnvironmentOutlined, CompassOutlined, HomeOutlined } from "@ant-design/icons";
import styled from "styled-components";
import {
  findCurrentEntry,
  findNextEntry,
  findTodayDay,
  formatCountdown,
  scheduledEntriesForDay,
  type Activity,
  type Itinerary,
  type ScheduledSlot,
  type Trip,
} from "../types";
import { directionsUrl } from "../utils";

const Card = styled.div`
  background: linear-gradient(135deg, #f6ffed 0%, #e6f7ff 100%);
  border: 1px solid #b7eb8f;
  border-radius: 10px;
  padding: 16px 20px;
  margin-bottom: 20px;
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
`;

const OpenDayButton = styled.button`
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid #1677ff;
  background: white;
  color: #1677ff;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: #1677ff;
    color: white;
  }
`;

const Title = styled.h3`
  margin: 0;
  font-size: 16px;
  font-weight: 600;
`;

const DayBadge = styled.span`
  font-size: 11px;
  color: #595959;
`;

const NextUp = styled.div`
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  background: white;
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 13px;
`;

const NextLabel = styled.span`
  color: #595959;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
`;

const NextName = styled.span`
  font-weight: 500;
`;

const NextCountdown = styled.span`
  margin-left: auto;
  color: #1677ff;
  font-weight: 500;
`;

const SlotList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const SlotRow = styled.div<{ $active?: boolean; $past?: boolean }>`
  display: grid;
  grid-template-columns: 52px 1fr auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 4px;
  background: ${(p) => (p.$active ? "rgba(22, 119, 255, 0.08)" : "transparent")};
  border-left: 3px solid ${(p) => (p.$active ? "#1677ff" : "transparent")};
  color: ${(p) => (p.$past ? "#bfbfbf" : "inherit")};
  font-size: 13px;
`;

const DirectionsButton = styled.a`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: #1677ff;
  color: white !important;
  font-size: 14px;
  text-decoration: none;
  flex-shrink: 0;

  &:hover {
    background: #4096ff;
    color: white;
  }
`;

const DirectionsPlaceholder = styled.span`
  width: 30px;
  height: 30px;
  flex-shrink: 0;
`;

const LodgingRow = styled.div`
  display: grid;
  grid-template-columns: 52px 1fr auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  margin-top: 8px;
  border-top: 1px dashed #d9d9d9;
  font-size: 13px;
  color: #595959;
`;

const SlotTime = styled.span`
  font-size: 11px;
  color: #1677ff;
  font-weight: 500;
`;

const SlotName = styled.span`
  font-weight: 500;
`;

const SlotLocation = styled.span`
  font-size: 11px;
  color: #8c8c8c;
  display: inline-flex;
  align-items: center;
  gap: 3px;
`;

const NowLine = styled.div`
  height: 1px;
  background: #ff4d4f;
  margin: 4px 0;
  position: relative;

  &::before {
    content: "now";
    position: absolute;
    left: 0;
    top: -7px;
    background: #ff4d4f;
    color: white;
    font-size: 9px;
    padding: 1px 6px;
    border-radius: 2px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
`;

const Empty = styled.div`
  color: #8c8c8c;
  font-size: 13px;
  font-style: italic;
  padding: 4px 0;
`;

function formatTimeHm(startMin: number): string {
  const h = Math.floor(startMin / 60);
  const m = startMin - h * 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

interface TodayCardProps {
  trip: Trip;
  itinerary: Itinerary;
  activityMap: Map<string, Activity>;
  /** Called when the user wants to drill into the day-detail view (with prev/next nav). */
  onOpenDay?: (dayIndex: number) => void;
  /** Optional injected "now" for testing; defaults to current time. */
  now?: Date;
}

export function TodayCard({ trip, itinerary, activityMap, onOpenDay, now: nowProp }: TodayCardProps) {
  // Auto-refresh every minute so countdowns / current-slot highlight stay live.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (nowProp) return; // caller owns the clock
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [nowProp]);

  const now = nowProp ?? new Date();
  void tick; // included in dep tracking implicitly; just re-renders on tick

  const today = findTodayDay(itinerary, now);
  if (!today) return null;

  const entries = scheduledEntriesForDay(today.day, activityMap);
  const current = findCurrentEntry(entries, now);
  const next = findNextEntry(entries, now);
  const lodging = today.day.lodgingActivityId
    ? activityMap.get(today.day.lodgingActivityId)
    : null;

  const totalDays = itinerary.days.length;
  const dayNumber = today.index + 1;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  return (
    <Card>
      <Header>
        <Tag color="green" style={{ margin: 0 }}>In progress</Tag>
        <Title>{trip.destination} — Today</Title>
        <DayBadge>Day {dayNumber} of {totalDays}</DayBadge>
        {onOpenDay && (
          <OpenDayButton onClick={() => onOpenDay(today.index)}>
            Open day →
          </OpenDayButton>
        )}
      </Header>

      {current ? (
        <NextUp>
          <NextLabel>Now</NextLabel>
          <NextName>{current.activity.name}</NextName>
          {current.activity.location && (
            <SlotLocation><EnvironmentOutlined /> {current.activity.location}</SlotLocation>
          )}
        </NextUp>
      ) : next ? (
        <NextUp>
          <NextLabel>Up next</NextLabel>
          <NextName>{next.entry.activity.name}</NextName>
          <NextCountdown>{formatCountdown(next.minutesUntil)}</NextCountdown>
        </NextUp>
      ) : entries.length > 0 ? (
        <NextUp>
          <NextLabel>All done</NextLabel>
          <NextName>Nothing else scheduled today</NextName>
        </NextUp>
      ) : null}

      {entries.length === 0 ? (
        <Empty>No scheduled activities today.</Empty>
      ) : (
        <SlotList>{renderRowsWithNowMarker(entries, current, nowMin)}</SlotList>
      )}

      {lodging && (
        <LodgingRow>
          <SlotTime style={{ color: "#fa8c16" }}>
            <HomeOutlined />
          </SlotTime>
          <span>
            <strong>Tonight:</strong> {lodging.name}
          </span>
          {lodging.location && (
            <SlotLocation>
              <EnvironmentOutlined /> {lodging.location}
            </SlotLocation>
          )}
          {directionsUrl(lodging) ? (
            <DirectionsButton
              href={directionsUrl(lodging)!}
              target="_blank"
              rel="noopener noreferrer"
              title={`Directions to ${lodging.name}`}
              onClick={(e) => e.stopPropagation()}
            >
              <CompassOutlined />
            </DirectionsButton>
          ) : (
            <DirectionsPlaceholder />
          )}
        </LodgingRow>
      )}
    </Card>
  );
}

function renderRowsWithNowMarker(
  entries: ScheduledSlot[],
  current: ScheduledSlot | null,
  nowMin: number,
): ReactElement[] {
  const rows: ReactElement[] = [];
  let nowLineRendered = false;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const isActive = current?.slot === e.slot;

    // Insert the "now" line between entries when nowMin falls between this
    // entry's start and the next's start (and we're not currently in any).
    if (!nowLineRendered && !current && nowMin < e.startMin) {
      rows.push(<NowLine key="now-line" />);
      nowLineRendered = true;
    }

    const past = !isActive && e.endMin > e.startMin && nowMin >= e.endMin;

    const dir = directionsUrl(e.activity);
    rows.push(
      <SlotRow key={`${e.source}-${i}`} $active={isActive} $past={past}>
        <SlotTime>{formatTimeHm(e.startMin)}</SlotTime>
        <SlotName>
          {e.source === "flights" ? "✈ " : ""}{e.activity.name}
        </SlotName>
        {e.activity.location ? (
          <SlotLocation><EnvironmentOutlined /> {e.activity.location}</SlotLocation>
        ) : <span />}
        {dir ? (
          <DirectionsButton
            href={dir}
            target="_blank"
            rel="noopener noreferrer"
            title={`Directions to ${e.activity.name}`}
            onClick={(ev) => ev.stopPropagation()}
          >
            <CompassOutlined />
          </DirectionsButton>
        ) : (
          <DirectionsPlaceholder />
        )}
      </SlotRow>
    );
  }

  // If every scheduled entry ended before now, the marker goes at the bottom.
  if (!nowLineRendered && !current) {
    const last = entries[entries.length - 1];
    if (last && nowMin >= (last.endMin > last.startMin ? last.endMin : last.startMin)) {
      rows.push(<NowLine key="now-line" />);
    }
  }

  return rows;
}

// Re-export the check callers will use to decide whether to render the card.
export { isTripActive } from "../types";
