import { useState, useEffect, useRef, useCallback } from "react";
import styled, { css } from "styled-components";
import { InputNumber, Input, message, Spin } from "antd";
import { CheckCircleFilled, LoadingOutlined } from "@ant-design/icons";
import type { ComboWidget as ComboWidgetType, ComboField, LogEntry } from "../../types";
import { getEntriesForDate } from "../../types";
import { addEntry, updateEntry } from "../../firestore";
import { type WidgetSize } from "../../display-settings";
import { RatingInput } from "./inputs";

const sizeStyles = {
  compact: css`padding: var(--space-sm);`,
  normal: css`padding: var(--space-md);`,
  comfortable: css`padding: var(--space-lg);`,
};

const Card = styled.div<{ $size: WidgetSize }>`
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-lg);
  ${(props) => sizeStyles[props.$size]}
`;

const headerSizeStyles = {
  compact: css`margin-bottom: var(--space-sm);`,
  normal: css`margin-bottom: var(--space-md);`,
  comfortable: css`margin-bottom: var(--space-lg);`,
};

const Header = styled.div<{ $size: WidgetSize }>`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-sm);
  ${(props) => headerSizeStyles[props.$size]}
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


const FieldsContainer = styled.div<{ $size: WidgetSize }>`
  display: flex;
  flex-direction: column;
  gap: ${(props) => props.$size === "compact" ? "var(--space-xs)" : "var(--space-sm)"};
`;

const FieldRow = styled.div<{ $size: WidgetSize }>`
  display: flex;
  align-items: center;
  gap: ${(props) => props.$size === "compact" ? "var(--space-xs)" : "var(--space-sm)"};
`;

const fieldLabelSizeStyles = {
  compact: css`font-size: var(--font-size-xs); min-width: 50px;`,
  normal: css`font-size: var(--font-size-sm); min-width: 60px;`,
  comfortable: css`font-size: var(--font-size-base); min-width: 70px;`,
};

const FieldLabel = styled.span<{ $size: WidgetSize }>`
  color: var(--color-text-secondary);
  ${(props) => fieldLabelSizeStyles[props.$size]}
`;

const FieldInput = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
`;

const Unit = styled.span`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`;

const ExistingEntries = styled.div<{ $size: WidgetSize }>`
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  margin-top: var(--space-sm);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--color-border);
  ${(props) => props.$size === "compact" && css`display: none;`}
`;

interface ComboWidgetProps {
  widget: ComboWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
  size?: WidgetSize;
}

type FieldValue = number | string | null;

export function ComboWidget({ widget, entries, userId, logId, timestamp, size = "normal" }: ComboWidgetProps) {
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dayEntries = getEntriesForDate(entries, widget.id, timestamp);

  // Initialize values from the latest entry for this date
  useEffect(() => {
    if (dayEntries.length > 0) {
      const latestEntry = dayEntries[0]; // Already sorted by timestamp desc
      const initialValues: Record<string, FieldValue> = {};
      for (const field of widget.fields) {
        const val = latestEntry.data[field.id];
        if (val !== undefined && val !== null) {
          initialValues[field.id] = val as FieldValue;
        }
      }
      setValues(initialValues);
      setCurrentEntryId(latestEntry.id);
    } else {
      setValues({});
      setCurrentEntryId(null);
    }
  }, [dayEntries.length, widget.id, timestamp?.getTime()]);

  const saveData = useCallback(async (data: Record<string, FieldValue>, entryId: string | null) => {
    if (!logId || !userId) return;

    // Check if at least one field has a value
    const hasValue = Object.values(data).some((v) => v !== null && v !== "" && v !== 0);
    if (!hasValue) return;

    setSaving(true);
    setSaved(false);
    try {
      if (entryId) {
        // Update existing entry
        await updateEntry(entryId, { data }, logId);
      } else {
        // Create new entry
        await addEntry(widget.id, data, userId, { logId, timestamp });
      }
      setSaved(true);
      // Hide saved indicator after 2 seconds
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error("Failed to save:", error);
      message.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }, [logId, userId, widget.id, timestamp]);

  const updateValue = (fieldId: string, value: FieldValue) => {
    const newValues = { ...values, [fieldId]: value };
    setValues(newValues);

    // Debounce save - wait 800ms after last change
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveData(newValues, currentEntryId);
    }, 800);
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const renderField = (field: ComboField) => {
    const value = values[field.id];
    const inputSize = size === "compact" ? "small" : "middle";

    switch (field.type) {
      case "number":
        return (
          <FieldInput>
            <InputNumber
              value={value as number | null}
              onChange={(v) => updateValue(field.id, v)}
              min={field.min}
              max={field.max}
              placeholder="0"
              style={{ width: "100%" }}
              disabled={!logId}
              size={inputSize}
            />
            {field.unit && <Unit>{field.unit}</Unit>}
          </FieldInput>
        );

      case "rating": {
        return (
          <RatingInput
            value={value as number | null}
            onChange={(v) => updateValue(field.id, v)}
            max={field.max || 5}
            disabled={!logId}
            size={size}
            allowClear={true}
          />
        );
      }

      case "text":
        return (
          <Input
            value={(value as string) || ""}
            onChange={(e) => updateValue(field.id, e.target.value)}
            placeholder={field.placeholder || "Enter text"}
            disabled={!logId}
            size={inputSize}
          />
        );

      default:
        return null;
    }
  };

  // Format existing combo entries for additional entries display
  const formatEntry = (entry: LogEntry): string => {
    const parts: string[] = [];
    for (const field of widget.fields) {
      const val = entry.data[field.id];
      if (val !== undefined && val !== null && val !== "") {
        if (field.type === "rating") {
          parts.push(`${field.label}: ${"★".repeat(val as number)}`);
        } else if (field.type === "number" && field.unit) {
          parts.push(`${val}${field.unit}`);
        } else {
          parts.push(`${val}`);
        }
      }
    }
    return parts.join(", ");
  };

  const existingSummaries = dayEntries.slice(1).map(formatEntry).filter(s => s.length > 0);

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
      <FieldsContainer $size={size}>
        {widget.fields.map((field) => (
          <FieldRow key={field.id} $size={size}>
            <FieldLabel $size={size}>{field.label}</FieldLabel>
            {renderField(field)}
          </FieldRow>
        ))}
      </FieldsContainer>
      {existingSummaries.length > 0 && (
        <ExistingEntries $size={size}>
          +{existingSummaries.length} more: {existingSummaries.join(" · ")}
        </ExistingEntries>
      )}
    </Card>
  );
}
