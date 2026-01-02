import { useState } from "react";
import styled from "styled-components";
import { InputNumber, Input, Button, message } from "antd";
import { CheckOutlined } from "@ant-design/icons";
import type { ComboWidget as ComboWidgetType, ComboField, LogEntry } from "../../types";
import { getEntriesForDate } from "../../types";
import { addEntry } from "../../firestore";

const Card = styled.div`
  display: flex;
  flex-direction: column;
  padding: var(--space-md);
  background: var(--color-bg);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-lg);
`;

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-md);
`;

const Label = styled.span`
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--color-text);
`;

const FieldsContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
`;

const FieldRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
`;

const FieldLabel = styled.span`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  min-width: 60px;
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

const NumberRow = styled.div`
  display: flex;
  gap: 4px;
`;

const NumberButton = styled.button<{ $selected?: boolean }>`
  width: 28px;
  height: 28px;
  border: 1px solid ${props => props.$selected ? 'var(--color-primary)' : 'var(--color-border)'};
  border-radius: 4px;
  background: ${props => props.$selected ? 'var(--color-primary)' : 'var(--color-bg)'};
  color: ${props => props.$selected ? 'white' : 'var(--color-text)'};
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const ExistingEntries = styled.div`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-top: var(--space-sm);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--color-border);
`;

interface ComboWidgetProps {
  widget: ComboWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
}

type FieldValue = number | string | null;

export function ComboWidget({ widget, entries, userId, logId, timestamp }: ComboWidgetProps) {
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [saving, setSaving] = useState(false);
  const dayEntries = getEntriesForDate(entries, widget.id, timestamp);

  const updateValue = (fieldId: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  };

  const handleSave = async () => {
    if (!logId || !userId) return;

    // Check if at least one field has a value
    const hasValue = Object.values(values).some((v) => v !== null && v !== "");
    if (!hasValue) return;

    setSaving(true);
    try {
      await addEntry(widget.id, values, userId, { logId, timestamp });
      setValues({});
      message.success("Saved");
    } catch (error) {
      console.error("Failed to save:", error);
      message.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const renderField = (field: ComboField) => {
    const value = values[field.id];

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
            />
            {field.unit && <Unit>{field.unit}</Unit>}
          </FieldInput>
        );

      case "rating": {
        const max = field.max || 5;
        const numbers = Array.from({ length: max }, (_, i) => i + 1);
        const currentValue = value as number | null;
        return (
          <NumberRow>
            {numbers.map((n) => (
              <NumberButton
                key={n}
                $selected={currentValue !== null && n <= currentValue}
                disabled={!logId}
                onClick={() => updateValue(field.id, n)}
              >
                {n}
              </NumberButton>
            ))}
          </NumberRow>
        );
      }

      case "text":
        return (
          <Input
            value={(value as string) || ""}
            onChange={(e) => updateValue(field.id, e.target.value)}
            placeholder={field.placeholder || "Enter text"}
            disabled={!logId}
          />
        );

      default:
        return null;
    }
  };

  const hasValues = Object.values(values).some((v) => v !== null && v !== "" && v !== 0);

  // Format existing combo entries
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

  const existingSummaries = dayEntries.map(formatEntry).filter(s => s.length > 0);

  return (
    <Card>
      <Header>
        <Label>{widget.label}</Label>
        <Button
          type="primary"
          icon={<CheckOutlined />}
          onClick={handleSave}
          loading={saving}
          disabled={!hasValues || !logId}
          size="small"
        >
          Save
        </Button>
      </Header>
      <FieldsContainer>
        {widget.fields.map((field) => (
          <FieldRow key={field.id}>
            <FieldLabel>{field.label}</FieldLabel>
            {renderField(field)}
          </FieldRow>
        ))}
      </FieldsContainer>
      {existingSummaries.length > 0 && (
        <ExistingEntries>
          Logged: {existingSummaries.join(" · ")}
        </ExistingEntries>
      )}
    </Card>
  );
}
