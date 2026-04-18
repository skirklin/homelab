import { useState, useRef, useEffect, useCallback } from "react";
import { Checkbox, Button, Tag, Popconfirm } from "antd";
import {
  RightOutlined,
  DownOutlined,
  PlusOutlined,
  DeleteOutlined,
  CheckOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { useUpkeepBackend } from "@kirkl/shared";
import { formatDueDate, formatFrequency, isTaskSnoozed, formatSnoozeRemaining } from "../types";
import type { TaskNode } from "../types";

type DropZone = "before" | "inside" | "after" | null;

const Row = styled.div<{ $depth: number; $focused: boolean; $dragging: boolean; $dropZone: DropZone }>`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 4px ${(p) => 8 + p.$depth * 24}px;
  min-height: 32px;
  background: ${(p) => {
    if (p.$dragging) return "#e6f4ff";
    if (p.$dropZone === "inside") return "#e6f4ff";
    if (p.$focused) return "#f0f5ff";
    return "transparent";
  }};
  border-radius: 4px;
  cursor: pointer;
  opacity: ${(p) => (p.$dragging ? 0.5 : 1)};
  border-top: ${(p) => (p.$dropZone === "before" ? "2px solid #1677ff" : "2px solid transparent")};
  border-bottom: ${(p) => (p.$dropZone === "after" ? "2px solid #1677ff" : "2px solid transparent")};

  &:hover {
    background: ${(p) => (p.$focused ? "#f0f5ff" : "#fafafa")};
  }
`;

const DragHandle = styled.div`
  width: 12px;
  height: 16px;
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #d9d9d9;
  font-size: 10px;
  flex-shrink: 0;
  user-select: none;

  &:hover { color: #8c8c8c; }
  &::before { content: "\\2807"; }
`;

const CollapseBtn = styled.button`
  border: none;
  background: none;
  cursor: pointer;
  padding: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8c8c8c;
  font-size: 10px;
  flex-shrink: 0;
`;

const Spacer = styled.div`
  width: 16px;
  flex-shrink: 0;
`;

const Name = styled.span<{ $completed: boolean }>`
  flex: 1;
  min-width: 0;
  font-size: 13px;
  text-decoration: ${(p) => (p.$completed ? "line-through" : "none")};
  color: ${(p) => (p.$completed ? "#8c8c8c" : "#262626")};
`;

const NameInput = styled.input`
  flex: 1;
  min-width: 0;
  font-size: 13px;
  border: 1px solid #1677ff;
  border-radius: 3px;
  outline: none;
  background: white;
  padding: 1px 4px;
  font-family: inherit;
  box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1);
`;

const Meta = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #8c8c8c;
  flex-shrink: 0;
`;

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;

  ${Row}:hover & { opacity: 1; }
`;

interface OutlinerRowProps {
  node: TaskNode;
  focusedId: string | null;
  onFocus: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onAddSibling: (afterId: string, parentId: string) => void;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onSelect: (id: string) => void;
}

export function OutlinerRow({
  node,
  focusedId,
  onFocus,
  onAddChild,
  onAddSibling,
  onIndent,
  onOutdent,
  onMoveUp,
  onMoveDown,
  onSelect,
}: OutlinerRowProps) {
  const { task, children, depth } = node;
  const upkeep = useUpkeepBackend();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.name);
  const [dragging, setDragging] = useState(false);
  const [dropZone, setDropZone] = useState<DropZone>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasChildren = children.length > 0;
  const isFocused = focusedId === task.id;
  const isOneShot = task.taskType === "one_shot";
  const isDone = isOneShot ? task.completed : false;
  const isSnoozed = isTaskSnoozed(task);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleToggleCollapse = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    upkeep.toggleCollapsed(task.id);
  }, [upkeep, task.id]);

  const handleToggleComplete = useCallback(() => {
    upkeep.toggleComplete(task.id);
  }, [upkeep, task.id]);

  const handleCompleteRecurring = useCallback(() => {
    upkeep.completeTask(task.id, "", {});
  }, [upkeep, task.id]);

  const handleSaveName = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== task.name) {
      upkeep.updateTask(task.id, { name: trimmed });
    }
    setEditing(false);
  }, [editValue, task.id, task.name, upkeep]);

  const handleDelete = useCallback(() => {
    upkeep.deleteTask(task.id);
  }, [upkeep, task.id]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editing) {
      if (e.key === "Enter") {
        handleSaveName();
      } else if (e.key === "Escape") {
        setEditValue(task.name);
        setEditing(false);
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      onAddSibling(task.id, task.parentId);
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      onIndent(task.id);
    } else if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      onOutdent(task.id);
    } else if (e.key === " ") {
      e.preventDefault();
      handleToggleComplete();
    } else if (e.key === "F2") {
      e.preventDefault();
      setEditValue(task.name);
      setEditing(true);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        handleDelete();
      }
    } else if (e.key === "ArrowUp" && e.altKey) {
      e.preventDefault();
      onMoveUp(task.id);
    } else if (e.key === "ArrowDown" && e.altKey) {
      e.preventDefault();
      onMoveDown(task.id);
    }
  }, [editing, handleSaveName, handleToggleComplete, handleDelete, onAddSibling, onIndent, onOutdent, onMoveUp, onMoveDown, task.id, task.name, task.parentId]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  }, [task.id]);

  const handleDragEnd = useCallback(() => {
    setDragging(false);
  }, []);

  const getDropZone = useCallback((e: React.DragEvent): DropZone => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const third = rect.height / 3;
    if (y < third) return "before";
    if (y > third * 2) return "after";
    return "inside";
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropZone(getDropZone(e));
  }, [getDropZone]);

  const handleDragLeave = useCallback(() => {
    setDropZone(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    const zone = getDropZone(e);
    setDropZone(null);
    if (!draggedId || draggedId === task.id) return;

    // Prevent dropping a parent into its own subtree
    if (task.path.includes(draggedId)) return;

    if (zone === "inside") {
      // Drop as first child of this task
      upkeep.moveTask(draggedId, task.id, 0);
      if (task.collapsed) upkeep.toggleCollapsed(task.id);
    } else if (zone === "before") {
      upkeep.moveTask(draggedId, task.parentId || null, task.position - 0.5);
    } else {
      upkeep.moveTask(draggedId, task.parentId || null, task.position + 0.5);
    }
  }, [task.id, task.parentId, task.position, task.path, task.collapsed, upkeep, getDropZone]);

  return (
    <>
      <Row
        $depth={depth}
        $focused={isFocused}
        $dragging={dragging}
        $dropZone={dropZone}
        onClick={() => onFocus(task.id)}
        onDoubleClick={() => { setEditValue(task.name); setEditing(true); }}
        onKeyDown={handleKeyDown}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        tabIndex={0}
        data-task-id={task.id}
      >
        <DragHandle
          draggable
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        />

        {hasChildren ? (
          <CollapseBtn onClick={handleToggleCollapse}>
            {task.collapsed ? <RightOutlined /> : <DownOutlined />}
          </CollapseBtn>
        ) : (
          <Spacer />
        )}

        {editing ? (
          <NameInput
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSaveName}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <Name $completed={isDone}>{task.name}</Name>
        )}

        <Meta>
          {task.taskType === "recurring" && task.frequency && (
            <Tag color="blue" style={{ fontSize: 10, lineHeight: "16px", margin: 0 }}>
              {formatFrequency(task.frequency)}
            </Tag>
          )}
          {task.taskType === "recurring" && !isSnoozed && (
            <span>{formatDueDate(task)}</span>
          )}
          {isSnoozed && (
            <Tag color="orange" style={{ fontSize: 10, lineHeight: "16px", margin: 0 }}>
              Snoozed {formatSnoozeRemaining(task)}
            </Tag>
          )}
        </Meta>

        <Actions>
          {isOneShot && (
            <Checkbox
              checked={isDone}
              onChange={handleToggleComplete}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          {task.taskType === "recurring" && (
            <Button type="text" size="small" icon={<CheckOutlined />}
              onClick={(e) => { e.stopPropagation(); handleCompleteRecurring(); }}
              title="Mark done" style={{ color: "#52c41a" }} />
          )}
          <Button type="text" size="small" icon={<PlusOutlined />}
            onClick={(e) => { e.stopPropagation(); onAddChild(task.id); }}
            title="Add child" />
          <Button type="text" size="small"
            onClick={(e) => { e.stopPropagation(); onSelect(task.id); }}
            title="Edit details" style={{ fontSize: 10 }}>...</Button>
          <Popconfirm title={hasChildren ? "Delete task and all children?" : "Delete task?"} onConfirm={handleDelete}
            okButtonProps={{ danger: true }}>
            <Button type="text" size="small" danger icon={<DeleteOutlined />}
              onClick={(e) => e.stopPropagation()} title="Delete" />
          </Popconfirm>
        </Actions>
      </Row>

      {!task.collapsed && children.map((child) => (
        <OutlinerRow
          key={child.task.id}
          node={child}
          focusedId={focusedId}
          onFocus={onFocus}
          onAddChild={onAddChild}
          onAddSibling={onAddSibling}
          onIndent={onIndent}
          onOutdent={onOutdent}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
