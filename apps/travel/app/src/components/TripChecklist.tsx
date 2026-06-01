import { useState, useEffect, useMemo } from "react";
import { Button, Checkbox, Empty, Input, Progress, Typography, Space } from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useUpkeepBackend, useAuth, useUserBackend } from "@kirkl/shared";
import type { Task, TaskList } from "@homelab/backend";
import type { Activity, Trip } from "../types";

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
`;

const Item = styled.div<{ $done: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  text-decoration: ${(p) => (p.$done ? "line-through" : "none")};
  color: ${(p) => (p.$done ? "#8c8c8c" : "#262626")};

  &:hover .remove-btn {
    opacity: 1;
  }
`;

const AddRow = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 4px;
`;

const GroupHeader = styled.div`
  margin-top: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #595959;
`;

const GroupHint = styled.span`
  margin-left: 6px;
  font-size: 11px;
  font-weight: 400;
  color: #bfbfbf;
`;

// Order tasks for the General prep section (no activity link) — by position.
// Activity-linked groups are also sorted by position within group.
const byPosition = (a: Task, b: Task) => a.position - b.position;

// Activity-linked groups are sorted lodging first, then alphabetical by name —
// stable, predictable, and matches how the rest of the app tends to surface
// accommodations before the day's slots.
function compareActivities(a: Activity, b: Activity): number {
  const aLodging = a.category === "Accommodation" ? 0 : 1;
  const bLodging = b.category === "Accommodation" ? 0 : 1;
  if (aLodging !== bLodging) return aLodging - bLodging;
  return a.name.localeCompare(b.name);
}

function extractActivityId(task: Task): string | null {
  const tag = task.tags?.find((t) => t.startsWith("activity:"));
  return tag ? tag.slice("activity:".length) : null;
}

interface TripChecklistProps {
  trip: Trip;
  activities?: Activity[];
}

export function TripChecklist({ trip, activities = [] }: TripChecklistProps) {
  const { user } = useAuth();
  const upkeep = useUpkeepBackend();
  const userBackend = useUserBackend();
  const [listId, setListId] = useState<string | null>(null);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [listName, setListName] = useState<string>("");
  const [newItemText, setNewItemText] = useState("");
  const [loading, setLoading] = useState(true);

  const tripTag = `travel:${trip.id}`;
  const tripContainerTag = `container:trip:${trip.id}`;
  const trips = useMemo(() => allTasks, [allTasks]);
  // Every real prep task for this trip — container nodes excluded, but cleared
  // items kept. This is the set the progress fraction counts over. The per-trip
  // container ("Trips/<trip>") carries the travel tag itself in legacy data, so
  // identify containers as any task that parents another trip task (plus
  // anything tagged container:*).
  const tripTasks = useMemo(() => {
    const tagged = trips.filter((t) => t.tags?.includes(tripTag));
    const parentIds = new Set(tagged.map((t) => t.parentId).filter(Boolean));
    return tagged.filter((t) =>
      !parentIds.has(t.id) &&
      !t.tags?.some((tag) => tag.startsWith("container:")),
    );
  }, [trips, tripTag]);
  // Rendered list also hides cleared items, mirroring the outliner's default
  // "Clear done" view — but they still count toward the fraction above.
  const tasks = useMemo(() => tripTasks.filter((t) => !t.cleared), [tripTasks]);

  // Get the user's first household task list
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const slugs = await userBackend.getSlugs(user.uid, "household");
      const firstListId = Object.values(slugs)[0];
      if (!cancelled) setListId(firstListId || null);
    })();
    return () => { cancelled = true; };
  }, [user?.uid, userBackend]);

  // Subscribe to the list's tasks
  useEffect(() => {
    if (!listId || !user) return;
    let cancelled = false;
    const unsub = upkeep.subscribeToList(listId, user.uid, {
      onList: (l: TaskList) => { if (!cancelled) setListName(l.name); },
      onTasks: (all: Task[]) => {
        if (cancelled) return;
        setAllTasks(all);
        setLoading(false);
      },
      onCompletions: () => {},
    });
    return () => { cancelled = true; unsub(); };
  }, [listId, user?.uid, upkeep, tripTag]);

  const { done, total, pct } = useMemo(() => {
    const total = tripTasks.length;
    const done = tripTasks.filter((t) => t.completed).length;
    return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  }, [tripTasks]);

  // Build a map id → activity for fast lookup. Tasks with an `activity:<id>`
  // tag that doesn't match a real activity on this trip degrade to General prep —
  // we don't render an "unknown activity" header and we don't auto-clean tags.
  const activitiesById = useMemo(() => {
    const m = new Map<string, Activity>();
    for (const a of activities) m.set(a.id, a);
    return m;
  }, [activities]);

  // Group tasks into general (no activity link, or stale link) + per-activity buckets.
  const { generalTasks, activityGroups } = useMemo(() => {
    const general: Task[] = [];
    const groups = new Map<string, Task[]>();
    for (const task of tasks) {
      const aid = extractActivityId(task);
      if (aid && activitiesById.has(aid)) {
        const bucket = groups.get(aid) ?? [];
        bucket.push(task);
        groups.set(aid, bucket);
      } else {
        general.push(task);
      }
    }
    general.sort(byPosition);
    const orderedGroups: Array<{ activity: Activity; tasks: Task[] }> = [];
    for (const [aid, bucket] of groups) {
      const activity = activitiesById.get(aid)!;
      bucket.sort(byPosition);
      orderedGroups.push({ activity, tasks: bucket });
    }
    orderedGroups.sort((a, b) => compareActivities(a.activity, b.activity));
    return { generalTasks: general, activityGroups: orderedGroups };
  }, [tasks, activitiesById]);

  const ensureTripContainer = async (): Promise<string> => {
    if (!listId) throw new Error("No list");

    // Find or create "Trips" root container
    let tripsRoot = allTasks.find(
      (t) => !t.parentId && t.tags?.includes("container:trips"),
    );
    if (!tripsRoot) {
      const maxRootPos = allTasks
        .filter((t) => !t.parentId)
        .reduce((m, t) => Math.max(m, t.position), 0);
      const id = await upkeep.addTask(listId, {
        parentId: "",
        position: maxRootPos + 1,
        name: "Trips",
        description: "",
        taskType: "one_shot",
        frequency: { value: 1, unit: "days" },
        lastCompleted: null,
        deadline: null,
        deadlineLeadDays: null,
        completed: false,
        snoozedUntil: null,
        notifyUsers: [],
        tags: ["container:trips"],
        collapsed: false,
        cleared: false,
      });
      tripsRoot = { id, parentId: "" } as Task;
    }

    // Find or create this trip's container under Trips
    let tripContainer = allTasks.find((t) => t.tags?.includes(tripContainerTag));
    if (!tripContainer) {
      const childPos = allTasks
        .filter((t) => t.parentId === tripsRoot!.id)
        .reduce((m, t) => Math.max(m, t.position), 0);
      const id = await upkeep.addTask(listId, {
        parentId: tripsRoot.id,
        position: childPos + 1,
        name: trip.destination,
        description: "",
        taskType: "one_shot",
        frequency: { value: 1, unit: "days" },
        lastCompleted: null,
        deadline: null,
        deadlineLeadDays: null,
        completed: false,
        snoozedUntil: null,
        notifyUsers: [],
        tags: [tripContainerTag],
        collapsed: false,
        cleared: false,
      });
      tripContainer = { id, parentId: tripsRoot.id } as Task;
    }

    return tripContainer.id;
  };

  const handleAdd = async () => {
    const text = newItemText.trim();
    if (!text || !listId) return;
    const containerId = await ensureTripContainer();
    const siblings = allTasks.filter((t) => t.parentId === containerId);
    const maxPos = siblings.reduce((m, t) => Math.max(m, t.position), 0);
    await upkeep.addTask(listId, {
      parentId: containerId,
      position: maxPos + 1,
      name: text,
      description: "",
      taskType: "one_shot",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      deadline: null,
      deadlineLeadDays: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [tripTag],
      collapsed: false,
      cleared: false,
    });
    setNewItemText("");
  };

  const handleToggle = async (task: Task) => {
    await upkeep.toggleComplete(task.id);
  };

  const handleDelete = async (task: Task) => {
    await upkeep.deleteTask(task.id);
  };

  if (!user) return null;

  if (loading && listId) {
    return null;
  }

  if (!listId) {
    return (
      <Empty
        description="Create a task list first (in the Tasks app)"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }

  return (
    <Container>
      <HeaderRow>
        <Progress
          type="circle"
          percent={pct}
          size={32}
          strokeColor={pct === 100 ? "#52c41a" : "#1677ff"}
          format={() => <span style={{ fontSize: 10 }}>{done}/{total}</span>}
        />
        <Typography.Text strong>Trip Prep</Typography.Text>
        {listName && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            in {listName}
          </Typography.Text>
        )}
      </HeaderRow>

      {tasks.length === 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          No checklist items yet. Add one below.
        </Typography.Text>
      )}

      {generalTasks.length > 0 && activityGroups.length > 0 && (
        <GroupHeader>General prep</GroupHeader>
      )}
      {generalTasks.map((task) => (
        <Item key={task.id} $done={task.completed}>
          <Checkbox checked={task.completed} onChange={() => handleToggle(task)} />
          <span style={{ flex: 1 }}>{task.name}</span>
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            className="remove-btn"
            style={{ opacity: 0, transition: "opacity 0.15s" }}
            onClick={() => handleDelete(task)}
          />
        </Item>
      ))}

      {activityGroups.map(({ activity, tasks: groupTasks }) => (
        <div key={activity.id}>
          <GroupHeader>
            {activity.name}
            <GroupHint>linked to activity</GroupHint>
          </GroupHeader>
          {groupTasks.map((task) => (
            <Item key={task.id} $done={task.completed}>
              <Checkbox checked={task.completed} onChange={() => handleToggle(task)} />
              <span style={{ flex: 1 }}>{task.name}</span>
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                className="remove-btn"
                style={{ opacity: 0, transition: "opacity 0.15s" }}
                onClick={() => handleDelete(task)}
              />
            </Item>
          ))}
        </div>
      ))}

      <AddRow>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            size="small"
            placeholder="Add a prep item..."
            value={newItemText}
            onChange={(e) => setNewItemText(e.target.value)}
            onPressEnter={handleAdd}
          />
          <Button size="small" icon={<PlusOutlined />} onClick={handleAdd}>Add</Button>
        </Space.Compact>
      </AddRow>
    </Container>
  );
}
