import { useState, useEffect, useMemo } from "react";
import { Button, Checkbox, Empty, Input, Progress, Typography, Space } from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useUpkeepBackend, useAuth, useUserBackend } from "@kirkl/shared";
import type { Task, TaskList } from "@homelab/backend";
import type { Trip } from "../types";

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

interface TripChecklistProps {
  trip: Trip;
}

export function TripChecklist({ trip }: TripChecklistProps) {
  const { user } = useAuth();
  const upkeep = useUpkeepBackend();
  const userBackend = useUserBackend();
  const [listId, setListId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [listName, setListName] = useState<string>("");
  const [newItemText, setNewItemText] = useState("");
  const [loading, setLoading] = useState(true);

  const tripTag = `travel:${trip.id}`;

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
  }, [user, userBackend]);

  // Subscribe to the list's tasks
  useEffect(() => {
    if (!listId || !user) return;
    let cancelled = false;
    const unsub = upkeep.subscribeToList(listId, user.uid, {
      onList: (l: TaskList) => { if (!cancelled) setListName(l.name); },
      onTasks: (allTasks: Task[]) => {
        if (cancelled) return;
        setTasks(allTasks.filter((t) => t.tags?.includes(tripTag)));
        setLoading(false);
      },
      onCompletions: () => {},
    });
    return () => { cancelled = true; unsub(); };
  }, [listId, user, upkeep, tripTag]);

  const { done, total, pct } = useMemo(() => {
    const total = tasks.length;
    const done = tasks.filter((t) => t.completed).length;
    return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  }, [tasks]);

  const sortedTasks = useMemo(() =>
    [...tasks].sort((a, b) => a.position - b.position),
    [tasks],
  );

  const handleAdd = async () => {
    const text = newItemText.trim();
    if (!text || !listId) return;
    const maxPos = tasks.reduce((max, t) => Math.max(max, t.position), 0);
    await upkeep.addTask(listId, {
      parentId: "",
      position: maxPos + 1,
      name: text,
      description: "",
      taskType: "one_shot",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [tripTag],
      collapsed: false,
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

      {sortedTasks.length === 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          No checklist items yet. Add one below.
        </Typography.Text>
      )}

      {sortedTasks.map((task) => (
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
