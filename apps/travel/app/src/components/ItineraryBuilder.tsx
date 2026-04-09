import { useState, useMemo, useCallback } from "react";
import {
  DndContext,
  closestCenter,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Typography, Space, Input, Popconfirm } from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  HolderOutlined,
  EnvironmentOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import type { Activity, Itinerary, ItineraryDay, ItinerarySlot } from "../types";
import { dayTravelDistance } from "../types";
import { useTravelBackend } from "../backend-provider";
import { daysToBackend } from "../adapters";

// ==========================================
// Styled components
// ==========================================

const BuilderLayout = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
`;

const DayColumn = styled.div<{ $isOver?: boolean; $expanded?: boolean }>`
  width: ${(p) => p.$expanded ? "100%" : "calc(33.33% - 8px)"};
  min-width: 240px;
  background: ${(p) => (p.$isOver ? "#e6f4ff" : "#fafafa")};
  border-radius: 10px;
  padding: 12px;
  transition: background 0.15s, width 0.2s;
  cursor: ${(p) => p.$expanded ? "default" : "pointer"};

  @media (max-width: 1100px) {
    width: ${(p) => p.$expanded ? "100%" : "calc(50% - 6px)"};
  }

  @media (max-width: 700px) {
    width: 100%;
  }
`;

const DayHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e8e8e8;
`;

const DayTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
`;

const DayDistance = styled.div`
  font-size: 11px;
  color: #8c8c8c;
  display: flex;
  align-items: center;
  gap: 4px;
`;

const SlotList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 40px;
`;

const ActivityChip = styled.div<{ $isDragging?: boolean; $category?: string }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: white;
  border-radius: 6px;
  border: 1px solid ${(p) => (p.$isDragging ? "#1677ff" : "#f0f0f0")};
  box-shadow: ${(p) => (p.$isDragging ? "0 4px 12px rgba(0,0,0,0.15)" : "none")};
  cursor: grab;
  font-size: 13px;
  transition: border-color 0.15s;

  &:hover {
    border-color: #d9d9d9;
  }
`;

const GripHandle = styled.span`
  color: #d9d9d9;
  cursor: grab;
  display: flex;
  flex-shrink: 0;
`;

const ChipInfo = styled.div`
  flex: 1;
  min-width: 0;
`;

const ChipName = styled.div`
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const ChipMeta = styled.div`
  font-size: 11px;
  color: #8c8c8c;
  display: flex;
  gap: 6px;
`;

const TimeInput = styled(Input)`
  width: 72px;
  font-size: 12px;
`;

const PoolColumn = styled(DayColumn)`
  background: #fff7e6;
  border: 1px dashed #ffd591;
`;

const PoolTitle = styled(DayTitle)`
  color: #ad6800;
`;

// ==========================================
// Sortable activity item
// ==========================================

function SortableSlot({
  id,
  activity,
  slot,
  onTimeChange,
}: {
  id: string;
  activity: Activity | undefined;
  slot: ItinerarySlot;
  onTimeChange: (time: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <ActivityChip ref={setNodeRef} style={style} $isDragging={isDragging}>
      <GripHandle {...attributes} {...listeners}>
        <HolderOutlined />
      </GripHandle>
      <ChipInfo>
        <ChipName>{activity?.name || slot.activityId}</ChipName>
        <ChipMeta>
          {activity?.location && (
            <span>
              <EnvironmentOutlined /> {activity.location}
            </span>
          )}
          {activity?.category && <span>{activity.category}</span>}
        </ChipMeta>
      </ChipInfo>
      <TimeInput
        size="small"
        placeholder="Time"
        value={slot.startTime || ""}
        onChange={(e) => onTimeChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
    </ActivityChip>
  );
}

// ==========================================
// Droppable day container
// ==========================================

function DroppableDay({
  dayIndex,
  day,
  activities,
  activityMap,
  distance,
  expanded,
  onExpand,
  onTimeChange,
  onRemoveDay,
  onLabelChange,
}: {
  dayIndex: number;
  day: ItineraryDay;
  activities: ItinerarySlot[];
  activityMap: Map<string, Activity>;
  distance: number;
  expanded: boolean;
  onExpand: () => void;
  onTimeChange: (slotIndex: number, time: string) => void;
  onRemoveDay: () => void;
  onLabelChange: (label: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day-${dayIndex}` });
  const sortableIds = activities.map((_, i) => `day-${dayIndex}-slot-${i}`);

  return (
    <DayColumn $isOver={isOver} $expanded={expanded} ref={setNodeRef} onClick={expanded ? undefined : onExpand}>
      <DayHeader>
        <div style={{ flex: 1 }}>
          <Input
            size="small"
            variant="borderless"
            value={day.label}
            onChange={(e) => onLabelChange(e.target.value)}
            style={{ fontWeight: 600, fontSize: 13, padding: 0 }}
          />
        </div>
        <Space size={4}>
          {distance > 0 && (
            <DayDistance>
              <SwapOutlined /> {distance.toFixed(0)} mi
            </DayDistance>
          )}
          <Popconfirm title="Remove this day?" onConfirm={onRemoveDay} okText="Remove">
            <Button type="text" size="small" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      </DayHeader>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <SlotList>
          {activities.map((slot, i) => (
            <SortableSlot
              key={sortableIds[i]}
              id={sortableIds[i]}
              activity={activityMap.get(slot.activityId)}
              slot={slot}
              onTimeChange={(time) => onTimeChange(i, time)}
            />
          ))}
          {activities.length === 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12, padding: 8 }}>
              Drop activities here
            </Typography.Text>
          )}
        </SlotList>
      </SortableContext>
    </DayColumn>
  );
}

// ==========================================
// Main builder
// ==========================================

interface ItineraryBuilderProps {
  itinerary: Itinerary;
  activities: Activity[];
  activityMap: Map<string, Activity>;
}

export function ItineraryBuilder({ itinerary, activities, activityMap }: ItineraryBuilderProps) {
  const travel = useTravelBackend();
  const [days, setDays] = useState<ItineraryDay[]>(itinerary.days);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expandedDay, setExpandedDay] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Activities not in any day
  const scheduledIds = useMemo(() => {
    const set = new Set<string>();
    for (const day of days) {
      for (const slot of day.slots) set.add(slot.activityId);
    }
    return set;
  }, [days]);

  const unscheduled = useMemo(
    () => activities.filter((a) => !scheduledIds.has(a.id)),
    [activities, scheduledIds]
  );

  // Distance per day
  const dayDistances = useMemo(() => {
    return days.map((day) => {
      const dayActivities = day.slots
        .map((s) => activityMap.get(s.activityId))
        .filter((a): a is Activity => a != null);
      return dayTravelDistance(dayActivities);
    });
  }, [days, activityMap]);

  // Parse drag IDs
  const parseDragId = (id: string) => {
    const poolMatch = id.match(/^pool-(\d+)$/);
    if (poolMatch) return { type: "pool" as const, index: parseInt(poolMatch[1]) };
    const slotMatch = id.match(/^day-(\d+)-slot-(\d+)$/);
    if (slotMatch) return { type: "day" as const, dayIndex: parseInt(slotMatch[1]), slotIndex: parseInt(slotMatch[2]) };
    return null;
  };

  const findContainer = (id: string) => {
    if (id.startsWith("pool")) return "pool";
    const match = id.match(/^day-(\d+)/);
    return match ? `day-${match[1]}` : null;
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const activeData = parseDragId(active.id as string);
    const overData = parseDragId(over.id as string);
    if (!activeData) return;

    // Get the activity ID being dragged
    let activityId: string;
    if (activeData.type === "pool") {
      activityId = unscheduled[activeData.index]?.id;
    } else {
      activityId = days[activeData.dayIndex]?.slots[activeData.slotIndex]?.activityId;
    }
    if (!activityId) return;

    const overContainer = findContainer(over.id as string);

    setDays((prev) => {
      const next = prev.map((d) => ({
        ...d,
        slots: d.slots.map((s) => ({ ...s })),
      }));

      // Remove from source
      if (activeData.type === "day") {
        next[activeData.dayIndex].slots.splice(activeData.slotIndex, 1);
      }

      // If dropping on a day container or slot within a day
      if (overContainer?.startsWith("day-")) {
        const dayIdx = parseInt(overContainer.split("-")[1]);

        if (overData?.type === "day" && overData.dayIndex === activeData.dayIndex && activeData.type === "day") {
          // Same day reorder
          const restored = prev.map((d) => ({ ...d, slots: [...d.slots] }));
          restored[activeData.dayIndex].slots = arrayMove(
            restored[activeData.dayIndex].slots,
            activeData.slotIndex,
            overData.slotIndex
          );
          setDirty(true);
          return restored;
        }

        // Insert at position or end
        const insertIdx = overData?.type === "day" ? overData.slotIndex : next[dayIdx].slots.length;
        next[dayIdx].slots.splice(insertIdx, 0, { activityId });
      }
      // If dropping on pool, just remove from day (already done above)

      setDirty(true);
      return next;
    });
  }, [days, unscheduled]);

  const handleDragOver = (_event: DragOverEvent) => {
    // Could add visual feedback here
  };

  const handleTimeChange = (dayIndex: number, slotIndex: number, time: string) => {
    setDays((prev) => {
      const next = [...prev];
      next[dayIndex] = { ...next[dayIndex], slots: [...next[dayIndex].slots] };
      next[dayIndex].slots[slotIndex] = { ...next[dayIndex].slots[slotIndex], startTime: time };
      return next;
    });
    setDirty(true);
  };

  const handleLabelChange = (dayIndex: number, label: string) => {
    setDays((prev) => {
      const next = [...prev];
      next[dayIndex] = { ...next[dayIndex], label };
      return next;
    });
    setDirty(true);
  };

  const addDay = () => {
    setDays((prev) => [
      ...prev,
      { label: `Day ${prev.length + 1}`, slots: [] },
    ]);
    setDirty(true);
  };

  const removeDay = (index: number) => {
    setDays((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await travel.setItineraryDays(itinerary.id, daysToBackend(days));
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  // Overlay item when dragging
  const activeActivity = useMemo(() => {
    if (!activeId) return null;
    const parsed = parseDragId(activeId);
    if (!parsed) return null;
    if (parsed.type === "pool") return unscheduled[parsed.index];
    return activityMap.get(days[parsed.dayIndex]?.slots[parsed.slotIndex]?.activityId);
  }, [activeId, days, unscheduled, activityMap]);

  // Pool sortable IDs
  const poolIds = unscheduled.map((_, i) => `pool-${i}`);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <Space>
          <Button size="small" icon={<PlusOutlined />} onClick={addDay}>
            Add Day
          </Button>
        </Space>
        {dirty && (
          <Button type="primary" size="small" loading={saving} onClick={handleSave}>
            Save Changes
          </Button>
        )}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
      >
        <BuilderLayout>
          {days.map((day, i) => (
            <DroppableDay
              key={i}
              dayIndex={i}
              day={day}
              activities={day.slots}
              activityMap={activityMap}
              distance={dayDistances[i]}
              expanded={expandedDay === i}
              onExpand={() => setExpandedDay(expandedDay === i ? null : i)}
              onTimeChange={(si, time) => handleTimeChange(i, si, time)}
              onRemoveDay={() => removeDay(i)}
              onLabelChange={(label) => handleLabelChange(i, label)}
            />
          ))}

          {/* Unscheduled pool */}
          <PoolColumn>
            <DayHeader>
              <PoolTitle>Unscheduled ({unscheduled.length})</PoolTitle>
            </DayHeader>
            <SortableContext items={poolIds} strategy={verticalListSortingStrategy}>
              <SlotList>
                {unscheduled.map((activity, i) => (
                  <SortableSlot
                    key={poolIds[i]}
                    id={poolIds[i]}
                    activity={activity}
                    slot={{ activityId: activity.id }}
                    onTimeChange={() => {}}
                  />
                ))}
                {unscheduled.length === 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12, padding: 8 }}>
                    All activities scheduled
                  </Typography.Text>
                )}
              </SlotList>
            </SortableContext>
          </PoolColumn>
        </BuilderLayout>

        <DragOverlay>
          {activeActivity ? (
            <ActivityChip $isDragging>
              <GripHandle>
                <HolderOutlined />
              </GripHandle>
              <ChipInfo>
                <ChipName>{activeActivity.name}</ChipName>
                <ChipMeta>
                  {activeActivity.location && (
                    <span>
                      <EnvironmentOutlined /> {activeActivity.location}
                    </span>
                  )}
                </ChipMeta>
              </ChipInfo>
            </ActivityChip>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
