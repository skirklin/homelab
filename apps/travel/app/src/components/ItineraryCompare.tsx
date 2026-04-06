import { useMemo } from "react";
import { Tag, Typography, Popover } from "antd";
import {
  PlusCircleOutlined,
  MinusCircleOutlined,
  SwapOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import {
  EnvironmentOutlined,
  ClockCircleOutlined,
  DollarOutlined,
} from "@ant-design/icons";
import type { Activity, Itinerary } from "../types";

const Container = styled.div`
  overflow-x: auto;
`;

const DayRow = styled.div`
  display: flex;
  gap: 0;
  border-bottom: 1px solid #f0f0f0;
  &:last-child { border-bottom: none; }
`;

const DayLabelCell = styled.div`
  min-width: 140px;
  max-width: 140px;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 600;
  color: #595959;
  background: #fafafa;
  border-right: 1px solid #f0f0f0;
  position: sticky;
  left: 0;
  z-index: 1;
`;

const ItinCell = styled.div<{ $isActive?: boolean }>`
  flex: 1;
  min-width: 200px;
  padding: 6px 10px;
  border-right: 1px solid #f5f5f5;
  &:last-child { border-right: none; }
  ${(p) => p.$isActive ? "background: #f0f9ff;" : ""}
`;

const HeaderRow = styled(DayRow)`
  border-bottom: 2px solid #e8e8e8;
  position: sticky;
  top: 0;
  z-index: 2;
  background: white;
`;

const HeaderCell = styled(ItinCell)`
  font-weight: 600;
  font-size: 13px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: ${(p) => p.$isActive ? "#e6f4ff" : "#fafafa"};
`;

const SlotLine = styled.div<{ $diff?: "added" | "removed" | "moved" | "same" }>`
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  gap: 4px;
  background: ${(p) => {
    switch (p.$diff) {
      case "added": return "#f6ffed";
      case "removed": return "#fff1f0";
      case "moved": return "#e6f4ff";
      default: return "transparent";
    }
  }};
  color: ${(p) => {
    switch (p.$diff) {
      case "removed": return "#8c8c8c";
      default: return "inherit";
    }
  }};
  text-decoration: ${(p) => p.$diff === "removed" ? "line-through" : "none"};
`;

const DiffIcon = styled.span<{ $type: string }>`
  font-size: 10px;
  color: ${(p) => {
    switch (p.$type) {
      case "added": return "#52c41a";
      case "removed": return "#ff4d4f";
      case "moved": return "#1677ff";
      default: return "#d9d9d9";
    }
  }};
`;

const EmptyDay = styled.div`
  color: #d9d9d9;
  font-size: 11px;
  font-style: italic;
  padding: 2px 4px;
`;

const PopoverContent = styled.div`
  max-width: 280px;
  font-size: 12px;
`;

const PopoverTitle = styled.div`
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
`;

const PopoverMeta = styled.div`
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: #595959;
`;

const PopoverRow = styled.div`
  display: flex;
  align-items: center;
  gap: 5px;
`;

const ActivityName = styled.span`
  cursor: pointer;
  &:hover { text-decoration: underline; }
`;

const SummaryBar = styled.div`
  display: flex;
  gap: 16px;
  padding: 8px 12px;
  background: #fafafa;
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 12px;
`;

const SummaryStat = styled.span<{ $color: string }>`
  display: flex;
  align-items: center;
  gap: 4px;
  color: ${(p) => p.$color};
  font-weight: 500;
`;

interface ItineraryCompareProps {
  itineraries: Itinerary[];
  activityMap: Map<string, Activity>;
}

export function ItineraryCompare({ itineraries, activityMap }: ItineraryCompareProps) {
  // Align itineraries by date when available, falling back to day index.
  // Each row gets a key (date string or "idx-N") used to align across itineraries.
  const itinDayMaps = useMemo(() => {
    return itineraries.map((itin) => {
      const map = new Map<string, { label: string; activityIds: string[] }>();
      itin.days.forEach((day, i) => {
        const key = day.date || `idx-${i}`;
        map.set(key, { label: day.label, activityIds: day.slots.map((s) => s.activityId) });
      });
      return map;
    });
  }, [itineraries]);

  // Collect all unique day keys in chronological order
  const allDayKeys = useMemo(() => {
    const seen = new Map<string, number>(); // key -> first seen order
    let order = 0;
    for (const itin of itineraries) {
      itin.days.forEach((day, i) => {
        const key = day.date || `idx-${i}`;
        if (!seen.has(key)) seen.set(key, order++);
      });
    }
    return Array.from(seen.entries())
      .sort((a, b) => {
        // Sort dates chronologically, index keys by their order
        const aIsDate = !a[0].startsWith("idx-");
        const bIsDate = !b[0].startsWith("idx-");
        if (aIsDate && bIsDate) return a[0].localeCompare(b[0]);
        if (aIsDate !== bIsDate) return aIsDate ? -1 : 1;
        return a[1] - b[1];
      })
      .map(([key]) => key);
  }, [itineraries]);

  const getDiff = (activityId: string, itinIndex: number, dayKey: string): "added" | "moved" | "same" => {
    const othersHaveInSameDay = itinDayMaps.some((map, i) => {
      if (i === itinIndex) return false;
      return (map.get(dayKey)?.activityIds || []).includes(activityId);
    });
    if (othersHaveInSameDay) return "same";

    const othersHaveAnywhere = itinDayMaps.some((map, i) => {
      if (i === itinIndex) return false;
      for (const entry of map.values()) {
        if (entry.activityIds.includes(activityId)) return true;
      }
      return false;
    });
    if (othersHaveAnywhere) return "moved";

    return "added";
  };

  // Summary stats per itinerary pair (compare each against the first/active)
  const summaries = useMemo(() => {
    const baseIdx = Math.max(0, itineraries.findIndex((i) => i.isActive));
    const baseActivities = new Set<string>();
    for (const day of itineraries[baseIdx].days) {
      for (const slot of day.slots) baseActivities.add(slot.activityId);
    }

    return itineraries.map((itin, idx) => {
      if (idx === baseIdx) return null;
      const theseActivities = new Set<string>();
      for (const day of itin.days) {
        for (const slot of day.slots) theseActivities.add(slot.activityId);
      }
      let added = 0, removed = 0, moved = 0;
      for (const id of theseActivities) {
        if (!baseActivities.has(id)) added++;
      }
      for (const id of baseActivities) {
        if (!theseActivities.has(id)) removed++;
      }
      // Count moved: in both but on different day index
      for (const id of theseActivities) {
        if (!baseActivities.has(id)) continue;
        const baseDayMap = itinDayMaps[baseIdx];
        const thisDayMap = itinDayMaps[idx];
        let baseDayKey = "", thisDayKey = "";
        for (const [dk, entry] of baseDayMap) { if (entry.activityIds.includes(id)) { baseDayKey = dk; break; } }
        for (const [dk, entry] of thisDayMap) { if (entry.activityIds.includes(id)) { thisDayKey = dk; break; } }
        if (baseDayKey !== thisDayKey) moved++;
      }
      return { added, removed, moved, name: itin.name };
    }).filter(Boolean);
  }, [itineraries, itinDayMaps]);

  if (itineraries.length < 2) return null;

  return (
    <Container>
      {summaries.length > 0 && (
        <SummaryBar>
          {summaries.map((s, i) => s && (
            <span key={i} style={{ display: "flex", gap: 12 }}>
              <Typography.Text strong style={{ fontSize: 12 }}>vs {s.name}:</Typography.Text>
              {s.added > 0 && <SummaryStat $color="#52c41a"><PlusCircleOutlined /> {s.added} added</SummaryStat>}
              {s.removed > 0 && <SummaryStat $color="#ff4d4f"><MinusCircleOutlined /> {s.removed} removed</SummaryStat>}
              {s.moved > 0 && <SummaryStat $color="#1677ff"><SwapOutlined /> {s.moved} moved</SummaryStat>}
              {s.added === 0 && s.removed === 0 && s.moved === 0 && (
                <SummaryStat $color="#52c41a"><CheckCircleOutlined /> identical</SummaryStat>
              )}
            </span>
          ))}
        </SummaryBar>
      )}

      <HeaderRow>
        <DayLabelCell>Day</DayLabelCell>
        {itineraries.map((itin) => (
          <HeaderCell key={itin.id} $isActive={itin.isActive}>
            {itin.name}
            {itin.isActive && <Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}>active</Tag>}
          </HeaderCell>
        ))}
      </HeaderRow>

      {allDayKeys.map((dayKey) => {
        // Use the first itinerary that has this day key for the row label
        const rowLabel = itinDayMaps
          .map((m) => m.get(dayKey)?.label)
          .find(Boolean) || dayKey;

        return (
          <DayRow key={dayKey}>
            <DayLabelCell>{rowLabel}</DayLabelCell>
            {itineraries.map((itin, itinIdx) => {
              const dayData = itinDayMaps[itinIdx].get(dayKey);
              const dayActivities = dayData?.activityIds || [];
              return (
                <ItinCell key={itin.id} $isActive={itin.isActive}>
                  {dayActivities.length === 0 ? (
                    <EmptyDay>—</EmptyDay>
                  ) : (
                    dayActivities.map((actId, j) => {
                      const activity = activityMap.get(actId);
                      const diff = getDiff(actId, itinIdx, dayKey);
                      const name = activity?.name || actId;
                      return (
                        <SlotLine key={j} $diff={diff}>
                          {diff !== "same" && (
                            <DiffIcon $type={diff}>
                              {diff === "added" && <PlusCircleOutlined />}
                              {diff === "moved" && <SwapOutlined />}
                            </DiffIcon>
                          )}
                          {activity ? (
                            <Popover
                              trigger="click"
                              placement="right"
                              content={
                                <PopoverContent>
                                  <PopoverTitle>{activity.name}</PopoverTitle>
                                  <PopoverMeta>
                                    {activity.location && <PopoverRow><EnvironmentOutlined /> {activity.location}</PopoverRow>}
                                    <PopoverRow><Tag style={{ margin: 0, fontSize: 11, lineHeight: "16px", padding: "0 4px" }}>{activity.category}</Tag></PopoverRow>
                                    {activity.durationEstimate && <PopoverRow><ClockCircleOutlined /> {activity.durationEstimate}</PopoverRow>}
                                    {activity.costNotes && <PopoverRow><DollarOutlined /> {activity.costNotes}</PopoverRow>}
                                    {activity.description && <div style={{ marginTop: 4, color: "#8c8c8c" }}>{activity.description}</div>}
                                  </PopoverMeta>
                                </PopoverContent>
                              }
                            >
                              <ActivityName>{name}</ActivityName>
                            </Popover>
                          ) : (
                            <span>{name}</span>
                          )}
                        </SlotLine>
                      );
                    })
                  )}
                </ItinCell>
              );
            })}
          </DayRow>
        );
      })}
    </Container>
  );
}
