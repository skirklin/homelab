import { useState, useCallback, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Button, Empty, Spin, Typography, Input, Select, InputNumber, Tag, Space } from "antd";
import { PlusOutlined, CloseOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useUpkeepBackend } from "@kirkl/shared";
import { useUpkeepContext } from "../upkeep-context";
import { getTaskTree, getTasksFromState } from "../selectors";
import { formatFrequency } from "../types";
import type { Task } from "../types";
import { OutlinerRow } from "./OutlinerRow";

const Container = styled.div`
  max-width: 900px;
  margin: 0 auto;
  padding: 16px;
  display: flex;
  gap: 16px;
`;

const TreePane = styled.div`
  flex: 1;
  min-width: 0;
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
`;

const TreeContainer = styled.div`
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 8px 0;
  background: white;
`;

const DetailPane = styled.div`
  width: 280px;
  flex-shrink: 0;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 16px;
  background: white;
  align-self: flex-start;
  position: sticky;
  top: 72px;
`;

const DetailHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
`;

const DetailField = styled.div`
  margin-bottom: 12px;
`;

const FieldLabel = styled.div`
  font-size: 11px;
  color: #8c8c8c;
  margin-bottom: 4px;
  font-weight: 500;
`;

export function TaskOutliner({ embedded: _embedded = false }: { embedded?: boolean }) {
  const { slug } = useParams<{ slug: string }>();
  const { state, setCurrentList } = useUpkeepContext();
  const upkeep = useUpkeepBackend();
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listId = slug ? state.userSlugs[slug] : undefined;

  useEffect(() => {
    if (listId) setCurrentList(listId);
  }, [listId, setCurrentList]);

  const tree = getTaskTree(state);
  const allTasks = getTasksFromState(state);
  const selectedTask = selectedId ? allTasks.find((t) => t.id === selectedId) : null;

  const handleAddRoot = useCallback(async () => {
    if (!listId) return;
    const maxPos = allTasks
      .filter((t) => !t.parentId)
      .reduce((max, t) => Math.max(max, t.position), 0);
    const id = await upkeep.addTask(listId, {
      parentId: "",
      position: maxPos + 1,
      name: "New task",
      description: "",
      taskType: "one_shot",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    setFocusedId(id);
  }, [listId, allTasks, upkeep]);

  const handleAddChild = useCallback(async (parentId: string) => {
    if (!listId) return;
    const siblings = allTasks.filter((t) => t.parentId === parentId);
    const maxPos = siblings.reduce((max, t) => Math.max(max, t.position), 0);
    const id = await upkeep.addTask(listId, {
      parentId,
      position: maxPos + 1,
      name: "New task",
      description: "",
      taskType: "one_shot",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    const parent = allTasks.find((t) => t.id === parentId);
    if (parent?.collapsed) {
      await upkeep.toggleCollapsed(parentId);
    }
    setFocusedId(id);
  }, [listId, allTasks, upkeep]);

  const handleAddSibling = useCallback(async (afterId: string, parentId: string) => {
    if (!listId) return;
    const task = allTasks.find((t) => t.id === afterId);
    if (!task) return;
    const id = await upkeep.addTask(listId, {
      parentId,
      position: task.position + 0.5,
      name: "New task",
      description: "",
      taskType: "one_shot",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    setFocusedId(id);
  }, [listId, allTasks, upkeep]);

  const handleIndent = useCallback(async (taskId: string) => {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task) return;
    const siblings = allTasks
      .filter((t) => t.parentId === task.parentId)
      .sort((a, b) => a.position - b.position);
    const idx = siblings.findIndex((t) => t.id === taskId);
    if (idx <= 0) return;
    const newParent = siblings[idx - 1];
    const newSiblings = allTasks.filter((t) => t.parentId === newParent.id);
    const maxPos = newSiblings.reduce((max, t) => Math.max(max, t.position), 0);
    await upkeep.moveTask(taskId, newParent.id, maxPos + 1);
    if (newParent.collapsed) {
      await upkeep.toggleCollapsed(newParent.id);
    }
  }, [allTasks, upkeep]);

  const handleOutdent = useCallback(async (taskId: string) => {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task || !task.parentId) return;
    const parent = allTasks.find((t) => t.id === task.parentId);
    if (!parent) return;
    await upkeep.moveTask(taskId, parent.parentId || null, parent.position + 0.5);
  }, [allTasks, upkeep]);

  const handleMoveUp = useCallback(async (taskId: string) => {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task) return;
    const siblings = allTasks
      .filter((t) => t.parentId === task.parentId)
      .sort((a, b) => a.position - b.position);
    const idx = siblings.findIndex((t) => t.id === taskId);
    if (idx <= 0) return;
    const prev = siblings[idx - 1];
    const prevPrev = idx >= 2 ? siblings[idx - 2] : null;
    const newPos = prevPrev ? (prevPrev.position + prev.position) / 2 : prev.position - 1;
    await upkeep.updateTask(taskId, { position: newPos });
  }, [allTasks, upkeep]);

  const handleMoveDown = useCallback(async (taskId: string) => {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task) return;
    const siblings = allTasks
      .filter((t) => t.parentId === task.parentId)
      .sort((a, b) => a.position - b.position);
    const idx = siblings.findIndex((t) => t.id === taskId);
    if (idx < 0 || idx >= siblings.length - 1) return;
    const next = siblings[idx + 1];
    const nextNext = idx + 2 < siblings.length ? siblings[idx + 2] : null;
    const newPos = nextNext ? (next.position + nextNext.position) / 2 : next.position + 1;
    await upkeep.updateTask(taskId, { position: newPos });
  }, [allTasks, upkeep]);

  const handleUpdateField = useCallback(async (field: string, value: unknown) => {
    if (!selectedId) return;
    await upkeep.updateTask(selectedId, { [field]: value });
  }, [selectedId, upkeep]);

  // Get all descendant IDs of a task (including itself)
  const getSubtreeIds = useCallback((rootId: string): string[] => {
    const root = allTasks.find((t) => t.id === rootId);
    if (!root) return [];
    const result = [rootId];
    const stack = [rootId];
    while (stack.length) {
      const pid = stack.pop()!;
      for (const t of allTasks) {
        if (t.parentId === pid) {
          result.push(t.id);
          stack.push(t.id);
        }
      }
    }
    return result;
  }, [allTasks]);

  const handleToggleOneShot = useCallback(async (taskId: string) => {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task) return;
    const newState = !task.completed;
    // Cascade to one-shot descendants
    const ids = getSubtreeIds(taskId);
    await Promise.all(ids.map((id) => {
      const t = allTasks.find((x) => x.id === id);
      if (!t || t.taskType !== "one_shot") return;
      if (t.completed === newState) return;
      return upkeep.updateTask(id, { completed: newState });
    }));
  }, [allTasks, getSubtreeIds, upkeep]);

  const handleCompleteRecurring = useCallback(async (taskId: string) => {
    const ids = getSubtreeIds(taskId);
    await Promise.all(ids.map((id) => {
      const t = allTasks.find((x) => x.id === id);
      if (!t || t.taskType !== "recurring") return;
      return upkeep.completeTask(id, "", {});
    }));
  }, [allTasks, getSubtreeIds, upkeep]);

  if (state.loading) {
    return <Container><Spin size="large" /></Container>;
  }

  if (!listId) {
    return <Container><Empty description="Select a task list" /></Container>;
  }

  return (
    <Container>
      <TreePane>
        <Header>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {state.list?.name || "Tasks"}
          </Typography.Title>
          <Button icon={<PlusOutlined />} onClick={handleAddRoot}>
            Add task
          </Button>
        </Header>

        {tree.length === 0 ? (
          <Empty description="No tasks yet" />
        ) : (
          <TreeContainer>
            {tree.map((node) => (
              <OutlinerRow
                key={node.task.id}
                node={node}
                focusedId={focusedId}
                onFocus={setFocusedId}
                onAddChild={handleAddChild}
                onAddSibling={handleAddSibling}
                onIndent={handleIndent}
                onOutdent={handleOutdent}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onToggleOneShot={handleToggleOneShot}
                onCompleteRecurring={handleCompleteRecurring}
                onSelect={setSelectedId}
              />
            ))}
          </TreeContainer>
        )}
      </TreePane>

      {selectedTask && (
        <DetailPanel
          task={selectedTask}
          onUpdate={handleUpdateField}
          onClose={() => setSelectedId(null)}
        />
      )}
    </Container>
  );
}

function DetailPanel({ task, onUpdate, onClose }: {
  task: Task;
  onUpdate: (field: string, value: unknown) => void;
  onClose: () => void;
}) {
  const [tagInput, setTagInput] = useState("");

  return (
    <DetailPane>
      <DetailHeader>
        <Typography.Text strong style={{ fontSize: 14 }}>{task.name}</Typography.Text>
        <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} />
      </DetailHeader>

      <DetailField>
        <FieldLabel>Description</FieldLabel>
        <Input.TextArea
          value={task.description}
          onChange={(e) => onUpdate("description", e.target.value)}
          autoSize={{ minRows: 2, maxRows: 6 }}
          placeholder="Add a description..."
        />
      </DetailField>

      <DetailField>
        <FieldLabel>Type</FieldLabel>
        <Select
          value={task.taskType}
          onChange={(v) => onUpdate("taskType", v)}
          style={{ width: "100%" }}
          options={[
            { value: "one_shot", label: "One-shot (checkbox)" },
            { value: "recurring", label: "Recurring (frequency)" },
          ]}
        />
      </DetailField>

      {task.taskType === "recurring" && (
        <DetailField>
          <FieldLabel>Frequency</FieldLabel>
          <Space.Compact style={{ width: "100%" }}>
            <InputNumber
              min={1}
              value={task.frequency?.value || 1}
              onChange={(v) => onUpdate("frequency", { ...task.frequency, value: v || 1 })}
              style={{ width: 80 }}
            />
            <Select
              value={task.frequency?.unit || "days"}
              onChange={(v) => onUpdate("frequency", { ...task.frequency, unit: v })}
              style={{ flex: 1 }}
              options={[
                { value: "days", label: "days" },
                { value: "weeks", label: "weeks" },
                { value: "months", label: "months" },
              ]}
            />
          </Space.Compact>
          {task.frequency && (
            <div style={{ fontSize: 11, color: "#8c8c8c", marginTop: 4 }}>
              {formatFrequency(task.frequency)}
            </div>
          )}
        </DetailField>
      )}

      <DetailField>
        <FieldLabel>Tags</FieldLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
          {task.tags.map((tag) => (
            <Tag
              key={tag}
              closable
              onClose={() => onUpdate("tags", task.tags.filter((t) => t !== tag))}
              style={{ fontSize: 11 }}
            >
              {tag}
            </Tag>
          ))}
        </div>
        <Input
          size="small"
          placeholder="Add tag + Enter"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onPressEnter={() => {
            const trimmed = tagInput.trim();
            if (trimmed && !task.tags.includes(trimmed)) {
              onUpdate("tags", [...task.tags, trimmed]);
            }
            setTagInput("");
          }}
        />
      </DetailField>
    </DetailPane>
  );
}
