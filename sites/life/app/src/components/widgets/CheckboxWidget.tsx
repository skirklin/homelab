import { useState } from "react";
import styled, { css } from "styled-components";
import { message } from "antd";
import { CheckOutlined } from "@ant-design/icons";
import type { CheckboxWidget as CheckboxWidgetType, LogEntry } from "../../types";
import { getEntriesForDate } from "../../types";
import { addEntry, deleteEntry } from "../../firestore";
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

const Card = styled.button<{ $size: WidgetSize; $checked: boolean }>`
  display: flex;
  align-items: center;
  background: var(--color-bg);
  border: 2px solid ${props => props.$checked ? 'var(--color-primary)' : 'var(--color-border)'};
  border-radius: var(--radius-lg);
  cursor: pointer;
  text-align: left;
  width: 100%;
  ${(props) => sizeStyles[props.$size]}

  &:active {
    opacity: 0.7;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const checkboxSizeStyles = {
  compact: css`
    width: 28px;
    height: 28px;
    font-size: 14px;
  `,
  normal: css`
    width: 36px;
    height: 36px;
    font-size: 18px;
  `,
  comfortable: css`
    width: 44px;
    height: 44px;
    font-size: 22px;
  `,
};

const Checkbox = styled.div<{ $size: WidgetSize; $checked: boolean }>`
  border-radius: var(--radius-sm);
  background: ${props => props.$checked ? 'var(--color-primary)' : 'var(--color-bg-muted)'};
  color: ${props => props.$checked ? 'white' : 'transparent'};
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 2px solid ${props => props.$checked ? 'var(--color-primary)' : 'var(--color-border)'};
  transition: all 0.15s ease;
  ${(props) => checkboxSizeStyles[props.$size]}
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

interface CheckboxWidgetProps {
  widget: CheckboxWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
  size?: WidgetSize;
}

export function CheckboxWidget({ widget, entries, userId, logId, timestamp, size = "normal" }: CheckboxWidgetProps) {
  const [saving, setSaving] = useState(false);
  const dayEntries = getEntriesForDate(entries, widget.id, timestamp);
  const isChecked = dayEntries.length > 0;
  const currentEntryId = dayEntries[0]?.id;

  const handleToggle = async () => {
    if (!logId || !userId) return;

    setSaving(true);
    try {
      if (isChecked && currentEntryId) {
        // Uncheck - delete the entry
        await deleteEntry(currentEntryId, logId);
      } else {
        // Check - create an entry
        await addEntry(widget.id, { checked: true }, userId, { logId, timestamp });
      }
    } catch (error) {
      console.error("Failed to save:", error);
      message.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card $size={size} $checked={isChecked} onClick={handleToggle} disabled={saving || !logId}>
      <Checkbox $size={size} $checked={isChecked}>
        <CheckOutlined />
      </Checkbox>
      <Content>
        <Label $size={size}>{widget.label}</Label>
      </Content>
    </Card>
  );
}
