import { useState, useEffect, useRef, useCallback } from "react";
import styled, { css } from "styled-components";
import { InputNumber, Spin } from "antd";
import { CheckCircleFilled, LoadingOutlined } from "@ant-design/icons";
import { useFeedback } from "@kirkl/shared";
import type { NumberWidget as NumberWidgetType, LogEntry } from "../../types";
import { getEntriesForDate } from "../../types";
import { useLifeBackend } from "@kirkl/shared";
import { type WidgetSize } from "../../display-settings";

const sizeStyles = {
  compact: css`padding: var(--space-sm); min-height: 60px;`,
  normal: css`padding: var(--space-md); min-height: 80px;`,
  comfortable: css`padding: var(--space-lg); min-height: 100px;`,
};

const Card = styled.div<{ $size: WidgetSize }>`
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-lg);
  ${(props) => sizeStyles[props.$size]}
`;

const Header = styled.div<{ $size: WidgetSize }>`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: ${(props) => props.$size === "compact" ? "var(--space-xs)" : "var(--space-sm)"};
`;

const SaveIndicator = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
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

const InputRow = styled.div<{ $size: WidgetSize }>`
  display: flex;
  gap: ${(props) => props.$size === "compact" ? "var(--space-xs)" : "var(--space-sm)"};
  align-items: center;
`;

const StyledInput = styled(InputNumber)`
  flex: 1;
`;

const Unit = styled.span`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`;

const ExistingEntries = styled.div<{ $size: WidgetSize }>`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-top: var(--space-xs);
  ${(props) => props.$size === "compact" && css`display: none;`}
`;

interface NumberWidgetProps {
  widget: NumberWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
  size?: WidgetSize;
}

export function NumberWidget({ widget, entries, userId, logId, timestamp, size = "normal" }: NumberWidgetProps) {
  const { message } = useFeedback();
  const life = useLifeBackend();
  const [value, setValue] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dayEntries = getEntriesForDate(entries, widget.id, timestamp);

  // Initialize value from the latest entry for this date
  useEffect(() => {
    if (dayEntries.length > 0) {
      const latestEntry = dayEntries[0];
      const val = latestEntry.data.value as number;
      if (val !== undefined && val !== null) {
        setValue(val);
      }
      setCurrentEntryId(latestEntry.id);
    } else {
      setValue(null);
      setCurrentEntryId(null);
    }
  }, [dayEntries.length, widget.id, timestamp?.getTime()]);

  const saveData = useCallback(async (val: number | null, entryId: string | null) => {
    if (!logId || !userId || val === null) return;

    setSaving(true);
    setSaved(false);
    try {
      if (entryId) {
        await life.updateEntry(entryId, { data: { value: val } });
      } else {
        await life.addEntry(logId!, widget.id, { value: val }, userId, { timestamp });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error("Failed to save:", error);
      message.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }, [logId, userId, widget.id, timestamp, life]);

  const handleChange = (val: number | null) => {
    setValue(val);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveData(val, currentEntryId);
    }, 800);
  };

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Format additional entries (after the first)
  const existingValues = dayEntries.slice(1).map(e => {
    const val = e.data.value as number;
    return widget.unit ? `${val}${widget.unit}` : `${val}`;
  });

  const inputSize = size === "compact" ? "small" : "middle";

  return (
    <Card $size={size}>
      <Header $size={size}>
        <Label $size={size}>{widget.label}</Label>
        {saving && (
          <SaveIndicator>
            <Spin indicator={<LoadingOutlined style={{ fontSize: 12 }} spin />} />
            Saving...
          </SaveIndicator>
        )}
        {saved && !saving && (
          <SaveIndicator style={{ color: "var(--color-success)" }}>
            <CheckCircleFilled />
            Saved
          </SaveIndicator>
        )}
      </Header>
      <InputRow $size={size}>
        <StyledInput
          value={value}
          onChange={(v) => handleChange(v as number | null)}
          min={widget.min}
          max={widget.max}
          placeholder="Enter value"
          disabled={!logId}
          size={inputSize}
        />
        {widget.unit && <Unit>{widget.unit}</Unit>}
      </InputRow>
      {existingValues.length > 0 && (
        <ExistingEntries $size={size}>
          +{existingValues.length} more: {existingValues.join(", ")}
        </ExistingEntries>
      )}
    </Card>
  );
}
