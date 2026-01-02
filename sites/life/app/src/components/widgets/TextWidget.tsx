import { useState } from "react";
import styled from "styled-components";
import { Input, Button, message } from "antd";
import { CheckOutlined } from "@ant-design/icons";
import type { TextWidget as TextWidgetType, LogEntry } from "../../types";
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
  align-items: flex-start;
`;

const ExistingEntries = styled.div`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-top: var(--space-xs);
`;

interface TextWidgetProps {
  widget: TextWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
}

export function TextWidget({ widget, entries, userId, logId, timestamp }: TextWidgetProps) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const dayEntries = getEntriesForDate(entries, widget.id, timestamp);

  const handleSave = async () => {
    if (!logId || !userId || !value.trim()) return;

    setSaving(true);
    try {
      await addEntry(widget.id, { text: value.trim() }, userId, { logId, timestamp });
      setValue("");
      message.success("Saved");
    } catch (error) {
      console.error("Failed to save:", error);
      message.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Format existing text entries (truncate if too long)
  const existingTexts = dayEntries.map(e => {
    const text = e.data.text as string;
    return text.length > 30 ? text.slice(0, 30) + "…" : text;
  });

  return (
    <Card>
      <Label>{widget.label}</Label>
      <InputRow>
        {widget.multiline ? (
          <Input.TextArea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={widget.placeholder || "Enter text"}
            disabled={!logId}
            style={{ flex: 1 }}
          />
        ) : (
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={widget.placeholder || "Enter text"}
            disabled={!logId}
            onPressEnter={handleSave}
            style={{ flex: 1 }}
          />
        )}
        <Button
          type="primary"
          icon={<CheckOutlined />}
          onClick={handleSave}
          loading={saving}
          disabled={!value.trim() || !logId}
        >
          Save
        </Button>
      </InputRow>
      {existingTexts.length > 0 && (
        <ExistingEntries>
          Logged: {existingTexts.join("; ")}
        </ExistingEntries>
      )}
    </Card>
  );
}
