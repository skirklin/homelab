import { useState } from "react";
import styled from "styled-components";
import { Badge, message } from "antd";
import type { CounterWidget as CounterWidgetType, LogEntry } from "../../types";
import { getCountForDate } from "../../types";
import { addEntry } from "../../firestore";

const Card = styled.button`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-lg);
  background: var(--color-bg);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all 0.2s ease;
  min-height: 100px;

  &:hover {
    border-color: var(--color-primary);
    background: var(--color-bg-subtle);
  }

  &:active {
    transform: scale(0.98);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const Label = styled.span`
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--color-text);
  margin-top: var(--space-xs);
`;

const BadgeWrapper = styled.div`
  .ant-badge-count {
    background: var(--color-primary);
  }
`;

interface CounterWidgetProps {
  widget: CounterWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
}

export function CounterWidget({ widget, entries, userId, logId, timestamp }: CounterWidgetProps) {
  const [saving, setSaving] = useState(false);
  const count = getCountForDate(entries, widget.id, timestamp);

  const handleTap = async () => {
    if (!logId || !userId) return;

    setSaving(true);
    try {
      await addEntry(widget.id, { count: 1 }, userId, { logId, timestamp });
    } catch (error) {
      console.error("Failed to log:", error);
      message.error("Failed to log");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card onClick={handleTap} disabled={saving || !logId}>
      <BadgeWrapper>
        <Badge count={count} showZero={false}>
          <Label>{widget.label}</Label>
        </Badge>
      </BadgeWrapper>
    </Card>
  );
}
