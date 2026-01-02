import { useState } from "react";
import styled from "styled-components";
import { InputNumber, Button, message } from "antd";
import { CheckOutlined } from "@ant-design/icons";
import type { NumberWidget as NumberWidgetType, LogEntry } from "../../types";
import { getEntriesForDate } from "../../types";
import { addEntry } from "../../firestore";

const Card = styled.div`
  display: flex;
  flex-direction: column;
  padding: var(--space-md);
  background: var(--color-bg);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-lg);
  min-height: 100px;
`;

const Label = styled.span`
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--color-text);
  margin-bottom: var(--space-sm);
`;

const InputRow = styled.div`
  display: flex;
  gap: var(--space-sm);
  align-items: center;
`;

const StyledInput = styled(InputNumber)`
  flex: 1;
`;

const Unit = styled.span`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`;

const ExistingEntries = styled.div`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-top: var(--space-xs);
`;

interface NumberWidgetProps {
  widget: NumberWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
}

export function NumberWidget({ widget, entries, userId, logId, timestamp }: NumberWidgetProps) {
  const [value, setValue] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const dayEntries = getEntriesForDate(entries, widget.id, timestamp);

  const handleSave = async () => {
    if (!logId || !userId || value === null) return;

    setSaving(true);
    try {
      await addEntry(widget.id, { value }, userId, { logId, timestamp });
      setValue(null);
      message.success("Saved");
    } catch (error) {
      console.error("Failed to save:", error);
      message.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Format existing values
  const existingValues = dayEntries.map(e => {
    const val = e.data.value as number;
    return widget.unit ? `${val}${widget.unit}` : `${val}`;
  });

  return (
    <Card>
      <Label>{widget.label}</Label>
      <InputRow>
        <StyledInput
          value={value}
          onChange={(v) => setValue(v as number | null)}
          min={widget.min}
          max={widget.max}
          placeholder="Enter value"
          disabled={!logId}
        />
        {widget.unit && <Unit>{widget.unit}</Unit>}
        <Button
          type="primary"
          icon={<CheckOutlined />}
          onClick={handleSave}
          loading={saving}
          disabled={value === null || !logId}
        >
          Save
        </Button>
      </InputRow>
      {existingValues.length > 0 && (
        <ExistingEntries>
          Logged: {existingValues.join(", ")}
        </ExistingEntries>
      )}
    </Card>
  );
}
