import { useState } from "react";
import styled from "styled-components";
import { message } from "antd";

import type { RatingWidget as RatingWidgetType, LogEntry } from "../../types";
import { getEntriesForDate } from "../../types";
import { addEntry } from "../../firestore";

const Card = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-sm);
  background: var(--color-bg);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-lg);
  min-height: 80px;

  @media (min-width: 400px) {
    padding: var(--space-md);
    min-height: 100px;
  }
`;

const Label = styled.span`
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text);
  margin-bottom: var(--space-xs);

  @media (min-width: 400px) {
    font-size: var(--font-size-base);
    margin-bottom: var(--space-sm);
  }
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

  &:hover {
    background: var(--color-primary);
    color: white;
    border-color: var(--color-primary);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const ExistingEntries = styled.div`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-top: var(--space-xs);
  text-align: center;
`;

interface RatingWidgetProps {
  widget: RatingWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
}

export function RatingWidget({ widget, entries, userId, logId, timestamp }: RatingWidgetProps) {
  const [saving, setSaving] = useState(false);
  const dayEntries = getEntriesForDate(entries, widget.id, timestamp);

  const handleRate = async (value: number) => {
    if (!logId || !userId) return;

    setSaving(true);
    try {
      await addEntry(widget.id, { rating: value }, userId, { logId, timestamp });
      message.success("Saved");
    } catch (error) {
      console.error("Failed to save:", error);
      message.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const numbers = Array.from({ length: widget.max }, (_, i) => i + 1);

  // Format existing ratings as stars
  const existingRatings = dayEntries.map(e => {
    const rating = e.data.rating as number;
    return "★".repeat(rating);
  });

  return (
    <Card>
      <Label>{widget.label}</Label>
      <NumberRow>
        {numbers.map((n) => (
          <NumberButton
            key={n}
            $selected={false}
            disabled={saving || !logId}
            onClick={() => handleRate(n)}
          >
            {n}
          </NumberButton>
        ))}
      </NumberRow>
      {existingRatings.length > 0 && (
        <ExistingEntries>
          Logged: {existingRatings.join(", ")}
        </ExistingEntries>
      )}
    </Card>
  );
}
