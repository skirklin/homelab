import { useState, useEffect } from "react";
import styled from "styled-components";
import { Modal, Button, DatePicker, InputNumber, Input } from "antd";
import dayjs from "dayjs";
import { useFeedback } from "@kirkl/shared";
import type { LogEntry, LifeManifest } from "../types";
import { getWidget } from "../types";
import { useLifeBackend } from "../backend-provider";

const FormRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  margin-bottom: var(--space-md);
`;

const Label = styled.label`
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text);
`;

const NumberRow = styled.div`
  display: flex;
  gap: 6px;
`;

const NumberButton = styled.button<{ $selected?: boolean }>`
  width: 36px;
  height: 36px;
  border: 2px solid ${props => props.$selected ? 'var(--color-primary)' : 'var(--color-border)'};
  border-radius: 8px;
  background: ${props => props.$selected ? 'var(--color-primary)' : 'var(--color-bg)'};
  color: ${props => props.$selected ? 'white' : 'var(--color-text)'};
  cursor: pointer;
  font-size: 16px;
  font-weight: 600;
`;

interface EditEntryModalProps {
  open: boolean;
  onClose: () => void;
  entry: LogEntry | null;
  manifest: LifeManifest;
  logId: string | undefined;
}

export function EditEntryModal({ open, onClose, entry, manifest, logId }: EditEntryModalProps) {
  const { message } = useFeedback();
  const life = useLifeBackend();
  const [timestamp, setTimestamp] = useState<dayjs.Dayjs | null>(null);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && entry) {
      setTimestamp(dayjs(entry.timestamp));
      setData({ ...entry.data });
    }
  }, [open, entry]);

  if (!entry) return null;

  const widget = getWidget(manifest, entry.subjectId);

  const handleSave = async () => {
    if (!logId || !timestamp) return;

    setSaving(true);
    try {
      await life.updateEntry(entry.id, {
        timestamp: timestamp.toDate(),
        data,
      });
      message.success("Entry updated");
      onClose();
    } catch (error) {
      console.error("Failed to update:", error);
      message.error("Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const renderDataEditor = () => {
    if (!widget) return null;

    switch (widget.type) {
      case "counter":
        return (
          <FormRow>
            <Label>Count</Label>
            <InputNumber
              value={data.count as number}
              onChange={(v) => setData({ ...data, count: v })}
              min={1}
            />
          </FormRow>
        );

      case "number":
        return (
          <FormRow>
            <Label>{widget.label}</Label>
            <InputNumber
              value={data.value as number}
              onChange={(v) => setData({ ...data, value: v })}
              min={widget.min}
              max={widget.max}
              addonAfter={widget.unit}
            />
          </FormRow>
        );

      case "rating": {
        const currentValue = data.rating as number;
        const numbers = Array.from({ length: widget.max }, (_, i) => i + 1);
        return (
          <FormRow>
            <Label>{widget.label}</Label>
            <NumberRow>
              {numbers.map((n) => (
                <NumberButton
                  key={n}
                  $selected={currentValue !== undefined && n <= currentValue}
                  onClick={() => setData({ ...data, rating: n })}
                >
                  {n}
                </NumberButton>
              ))}
            </NumberRow>
          </FormRow>
        );
      }

      case "text":
        return (
          <FormRow>
            <Label>{widget.label}</Label>
            {widget.multiline ? (
              <Input.TextArea
                value={data.text as string}
                onChange={(e) => setData({ ...data, text: e.target.value })}
                rows={3}
              />
            ) : (
              <Input
                value={data.text as string}
                onChange={(e) => setData({ ...data, text: e.target.value })}
              />
            )}
          </FormRow>
        );

      case "combo":
        return (
          <>
            {widget.fields.map((field) => {
              const fieldValue = data[field.id];

              switch (field.type) {
                case "number":
                  return (
                    <FormRow key={field.id}>
                      <Label>{field.label}</Label>
                      <InputNumber
                        value={fieldValue as number}
                        onChange={(v) => setData({ ...data, [field.id]: v })}
                        min={field.min}
                        max={field.max}
                        addonAfter={field.unit}
                      />
                    </FormRow>
                  );

                case "rating": {
                  const max = field.max || 5;
                  const numbers = Array.from({ length: max }, (_, i) => i + 1);
                  const currentVal = fieldValue as number | undefined;
                  return (
                    <FormRow key={field.id}>
                      <Label>{field.label}</Label>
                      <NumberRow>
                        {numbers.map((n) => (
                          <NumberButton
                            key={n}
                            $selected={currentVal !== undefined && n <= currentVal}
                            onClick={() => setData({ ...data, [field.id]: n })}
                          >
                            {n}
                          </NumberButton>
                        ))}
                      </NumberRow>
                    </FormRow>
                  );
                }

                case "text":
                  return (
                    <FormRow key={field.id}>
                      <Label>{field.label}</Label>
                      <Input
                        value={(fieldValue as string) || ""}
                        onChange={(e) => setData({ ...data, [field.id]: e.target.value })}
                        placeholder={field.placeholder}
                      />
                    </FormRow>
                  );

                default:
                  return null;
              }
            })}
          </>
        );

      default:
        return null;
    }
  };

  const widgetLabel = widget?.label ?? (entry.subjectId === "__sample__" ? "Sample Response" : "Entry");

  return (
    <Modal
      title={`Edit ${widgetLabel}`}
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        <Button key="save" type="primary" onClick={handleSave} loading={saving}>
          Save
        </Button>,
      ]}
    >
      <FormRow>
        <Label>Date & Time</Label>
        <DatePicker
          showTime
          value={timestamp}
          onChange={setTimestamp}
          format="MMM D, YYYY h:mm A"
          disabledDate={(current) => current && current.isAfter(dayjs(), 'day')}
        />
      </FormRow>

      {renderDataEditor()}
    </Modal>
  );
}
