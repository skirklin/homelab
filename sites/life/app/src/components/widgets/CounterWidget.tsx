import { useState } from "react";
import styled, { css } from "styled-components";
import { message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import type { CounterWidget as CounterWidgetType, LogEntry } from "../../types";
import { getCountForDate } from "../../types";
import { addEntry } from "../../firestore";
import { type WidgetSize } from "../../display-settings";

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

const Card = styled.button<{ $size: WidgetSize }>`
  display: flex;
  align-items: center;
  background: var(--color-bg);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;
  ${(props) => sizeStyles[props.$size]}

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

const CountDisplay = styled.div<{ $hasCount: boolean; $size: WidgetSize }>`
  border-radius: 50%;
  background: ${(props) => (props.$hasCount ? "var(--color-primary)" : "var(--color-bg-muted)")};
  color: ${(props) => (props.$hasCount ? "white" : "var(--color-text-secondary)")};
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  flex-shrink: 0;
  ${(props) => countSizeStyles[props.$size]}
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
    <Card $size={size} onClick={handleTap} disabled={saving || !logId}>
      <CountDisplay $hasCount={count > 0} $size={size}>
        {count > 0 ? count : <PlusOutlined />}
      </CountDisplay>
      <Content>
        <Label $size={size}>{widget.label}</Label>
        <Hint $size={size}>Tap to log</Hint>
      </Content>
    </Card>
  );
}
