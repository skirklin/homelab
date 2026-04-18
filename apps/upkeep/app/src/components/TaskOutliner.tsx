import { useState, useCallback, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Button, Empty, Spin, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useUpkeepBackend } from "@kirkl/shared";
import { useUpkeepContext } from "../upkeep-context";
import { getTaskTree, getTasksFromState } from "../selectors";
import { OutlinerRow } from "./OutlinerRow";

const Container = styled.div`
  max-width: 700px;
  margin: 0 auto;
  padding: 16px;
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

export function TaskOutliner({ embedded: _embedded = false }: { embedded?: boolean }) {
  const { slug } = useParams<{ slug: string }>();
  const { state, setCurrentList } = useUpkeepContext();
  const upkeep = useUpkeepBackend();
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const listId = slug ? state.userSlugs[slug] : undefined;

  useEffect(() => {
    if (listId) setCurrentList(listId);
  }, [listId, setCurrentList]);

  const tree = getTaskTree(state);
  const allTasks = getTasksFromState(state);

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
    // Expand parent if collapsed
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
      position: task.position + 0.5, // Insert after
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
    // Find the previous sibling to become the new parent
    const siblings = allTasks
      .filter((t) => t.parentId === task.parentId)
      .sort((a, b) => a.position - b.position);
    const idx = siblings.findIndex((t) => t.id === taskId);
    if (idx <= 0) return; // No previous sibling
    const newParent = siblings[idx - 1];
    const newSiblings = allTasks.filter((t) => t.parentId === newParent.id);
    const maxPos = newSiblings.reduce((max, t) => Math.max(max, t.position), 0);
    await upkeep.moveTask(taskId, newParent.id, maxPos + 1);
    // Expand new parent if collapsed
    if (newParent.collapsed) {
      await upkeep.toggleCollapsed(newParent.id);
    }
  }, [allTasks, upkeep]);

  const handleOutdent = useCallback(async (taskId: string) => {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task || !task.parentId) return; // Already root
    const parent = allTasks.find((t) => t.id === task.parentId);
    if (!parent) return;
    // Move to grandparent, positioned after the parent
    await upkeep.moveTask(taskId, parent.parentId || null, parent.position + 0.5);
  }, [allTasks, upkeep]);

  if (state.loading) {
    return <Container><Spin size="large" /></Container>;
  }

  if (!listId) {
    return <Container><Empty description="Select a task list" /></Container>;
  }

  return (
    <Container>
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
            />
          ))}
        </TreeContainer>
      )}
    </Container>
  );
}
