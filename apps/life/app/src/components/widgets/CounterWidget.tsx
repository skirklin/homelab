import { useState } from "react";
import styled, { css } from "styled-components";
import { message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import type { CounterWidget as CounterWidgetType, LogEntry } from "../../types";
import { getEntriesForDate } from "../../types";
import { addEntry } from "../../pocketbase";
import { type WidgetSize } from "../../display-settings";
import { EntriesPopover } from "./EntriesPopover";

const sizeStyles = {
  compact: css`
    gap: var(--space-sm);
    padding: var(--space-sm);
    min-height: 50px;
  `,
  normal: css`
    gap: var(--space-md);
    padding: var(--space-md);
    min-height: 70px;
  `,
  comfortable: css`
    gap: var(--space-lg);
    padding: var(--space-lg);
    min-height: 90px;
  `,
};

const Card = styled.div<{ $size: WidgetSize }>`
  display: flex;
  align-items: center;
  background: var(--color-bg);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-lg);
  ${(props) => sizeStyles[props.$size]}
`;

const AddButton = styled.button`
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  padding: 0;
  min-width: 0;

  &:active {
    opacity: 0.7;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const countSizeStyles = {
  compact: css`
    width: 32px;
    height: 32px;
    font-size: 14px;
  `,
  normal: css`
    width: 44px;
    height: 44px;
    font-size: 18px;
  `,
  comfortable: css`
    width: 52px;
    height: 52px;
    font-size: 20px;
  `,
};

const CountDisplay = styled.button<{ $size: WidgetSize }>`
  border-radius: 50%;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  flex-shrink: 0;
  border: none;
  cursor: pointer;
  ${(props) => countSizeStyles[props.$size]}

  &:active {
    opacity: 0.7;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const CountButton = styled.button<{ $size: WidgetSize }>`
  border-radius: 50%;
  background: var(--color-primary);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  flex-shrink: 0;
  border: none;
  cursor: pointer;
  ${(props) => countSizeStyles[props.$size]}

  &:hover {
    opacity: 0.9;
  }

  &:active {
    transform: scale(0.95);
  }
`;

const Content = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
`;

const labelSizeStyles = {
  compact: css`font-size: var(--font-size-sm);`,
  normal: css`font-size: var(--font-size-base);`,
  comfortable: css`font-size: var(--font-size-lg);`,
};

const Label = styled.span<{ $size: WidgetSize }>`
  font-weight: 500;
  color: var(--color-text);
  ${(props) => labelSizeStyles[props.$size]}
`;

const Hint = styled.span<{ $size: WidgetSize }>`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  ${(props) => props.$size === "compact" && css`display: none;`}
`;

interface CounterWidgetProps {
  widget: CounterWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
  size?: WidgetSize;
}

export function CounterWidget({ widget, entries, userId, logId, timestamp, size = "normal" }: CounterWidgetProps) {
  const [saving, setSaving] = useState(false);
  const dayEntries = getEntriesForDate(entries, widget.id, timestamp);
  const count = dayEntries.length;

  const handleAdd = async () => {
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
    <Card $size={size}>
      {count > 0 ? (
        <EntriesPopover entries={dayEntries} logId={logId}>
          <CountButton $size={size}>
            {count}
          </CountButton>
        </EntriesPopover>
      ) : (
        <CountDisplay $size={size} onClick={handleAdd} disabled={saving || !logId}>
          <PlusOutlined />
        </CountDisplay>
      )}
      <AddButton onClick={handleAdd} disabled={saving || !logId}>
        <Content>
          <Label $size={size}>{widget.label}</Label>
          <Hint $size={size}>Tap to log</Hint>
        </Content>
      </AddButton>
    </Card>
  );
}
