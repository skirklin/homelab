import { useState, useRef, useEffect, useCallback } from "react";
import { Checkbox, Button, Tag } from "antd";
import {
  RightOutlined,
  DownOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { useUpkeepBackend } from "@kirkl/shared";
import { formatDueDate, formatFrequency, isTaskSnoozed, formatSnoozeRemaining } from "../types";
import type { TaskNode } from "../types";

const Row = styled.div<{ $depth: number; $focused: boolean }>`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 4px ${(p) => 8 + p.$depth * 24}px;
  min-height: 32px;
  background: ${(p) => (p.$focused ? "#f0f5ff" : "transparent")};
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background: ${(p) => (p.$focused ? "#f0f5ff" : "#fafafa")};
  }
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
  border: none;
  outline: none;
  background: transparent;
  padding: 0;
  font-family: inherit;
`;

const Meta = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #8c8c8c;
  flex-shrink: 0;
`;

interface OutlinerRowProps {
  node: TaskNode;
  focusedId: string | null;
  onFocus: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onAddSibling: (afterId: string, parentId: string) => void;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
}

export function OutlinerRow({
  node,
  focusedId,
  onFocus,
  onAddChild,
  onAddSibling,
  onIndent,
  onOutdent,
}: OutlinerRowProps) {
  const { task, children, depth } = node;
  const upkeep = useUpkeepBackend();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.name);
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
    if (isOneShot) {
      upkeep.toggleComplete(task.id);
    }
  }, [upkeep, task.id, isOneShot]);

  const handleSaveName = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== task.name) {
      upkeep.updateTask(task.id, { name: trimmed });
    }
    setEditing(false);
  }, [editValue, task.id, task.name, upkeep]);

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
    } else if (e.key === "F2" || (e.key === "Enter" && e.metaKey)) {
      e.preventDefault();
      setEditValue(task.name);
      setEditing(true);
    }
  }, [editing, handleSaveName, handleToggleComplete, onAddSibling, onIndent, onOutdent, task.id, task.name, task.parentId]);

  return (
    <>
      <Row
        $depth={depth}
        $focused={isFocused}
        onClick={() => onFocus(task.id)}
        onDoubleClick={() => { setEditValue(task.name); setEditing(true); }}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        data-task-id={task.id}
      >
        {hasChildren ? (
          <CollapseBtn onClick={handleToggleCollapse}>
            {task.collapsed ? <RightOutlined /> : <DownOutlined />}
          </CollapseBtn>
        ) : (
          <Spacer />
        )}

        {isOneShot && (
          <Checkbox
            checked={isDone}
            onChange={handleToggleComplete}
            onClick={(e) => e.stopPropagation()}
          />
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
          {isFocused && (
            <>
              <Button type="text" size="small" icon={<PlusOutlined />}
                onClick={(e) => { e.stopPropagation(); onAddChild(task.id); }}
                title="Add child" />
            </>
          )}
        </Meta>
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
        />
      ))}
    </>
  );
}
