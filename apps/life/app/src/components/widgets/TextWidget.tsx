import { useState, useEffect, useRef, useCallback } from "react";
import styled, { css } from "styled-components";
import { Input, Spin } from "antd";
import { CheckCircleFilled, LoadingOutlined } from "@ant-design/icons";
import { useFeedback } from "@kirkl/shared";
import type { TextWidget as TextWidgetType, LogEntry } from "../../types";
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

const SaveIndicator = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
`;

const ExistingEntries = styled.div<{ $size: WidgetSize }>`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-top: var(--space-xs);
  ${(props) => props.$size === "compact" && css`display: none;`}
`;

interface TextWidgetProps {
  widget: TextWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
  size?: WidgetSize;
}

export function TextWidget({ widget, entries, userId, logId, timestamp, size = "normal" }: TextWidgetProps) {
  const { message } = useFeedback();
  const life = useLifeBackend();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dayEntries = getEntriesForDate(entries, widget.id, timestamp);

  // Initialize value from the latest entry for this date
  useEffect(() => {
    if (dayEntries.length > 0) {
      const latestEntry = dayEntries[0];
      const text = latestEntry.data.text as string;
      if (text !== undefined && text !== null) {
        setValue(text);
      }
      setCurrentEntryId(latestEntry.id);
    } else {
      setValue("");
      setCurrentEntryId(null);
    }
  }, [dayEntries.length, widget.id, timestamp?.getTime()]);

  const saveData = useCallback(async (text: string, entryId: string | null) => {
    if (!logId || !userId || !text.trim()) return;

    setSaving(true);
    setSaved(false);
    try {
      if (entryId) {
        await life.updateEntry(entryId, { data: { text: text.trim() } });
      } else {
        await life.addEntry(logId!, widget.id, { text: text.trim() }, userId, { timestamp });
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

  const handleChange = (text: string) => {
    setValue(text);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveData(text, currentEntryId);
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
  const existingTexts = dayEntries.slice(1).map(e => {
    const text = e.data.text as string;
    return text.length > 30 ? text.slice(0, 30) + "…" : text;
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
      {widget.multiline ? (
        <Input.TextArea
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={widget.placeholder || "Enter text"}
          disabled={!logId}
          rows={size === "compact" ? 1 : 2}
          size={inputSize}
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={widget.placeholder || "Enter text"}
          disabled={!logId}
          size={inputSize}
        />
      )}
      {existingTexts.length > 0 && (
        <ExistingEntries $size={size}>
          +{existingTexts.length} more: {existingTexts.join("; ")}
        </ExistingEntries>
      )}
    </Card>
  );
}
