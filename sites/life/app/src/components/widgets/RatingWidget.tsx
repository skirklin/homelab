import { useState } from "react";
import styled, { css } from "styled-components";
import { message } from "antd";

import type { RatingWidget as RatingWidgetType, LogEntry } from "../../types";
import { getEntriesForDate } from "../../types";
import { addEntry } from "../../firestore";
import { type WidgetSize } from "../../display-settings";

const sizeStyles = {
  compact: css`
    padding: var(--space-xs);
    min-height: 50px;
  `,
  normal: css`
    padding: var(--space-sm);
    min-height: 70px;
  `,
  comfortable: css`
    padding: var(--space-md);
    min-height: 90px;
  `,
};

const Card = styled.div<{ $size: WidgetSize }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--color-bg);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-lg);
  ${(props) => sizeStyles[props.$size]}
`;

const Header = styled.div<{ $size: WidgetSize }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: ${(props) => props.$size === "compact" ? "var(--space-xs)" : "var(--space-sm)"};
`;

const labelSizeStyles = {
  compact: css`font-size: var(--font-size-xs);`,
  normal: css`font-size: var(--font-size-sm);`,
  comfortable: css`font-size: var(--font-size-base);`,
};

const Label = styled.span<{ $size: WidgetSize }>`
  font-weight: 500;
  color: var(--color-text);
  ${(props) => labelSizeStyles[props.$size]}
`;

const valueSizeStyles = {
  compact: css`font-size: var(--font-size-sm);`,
  normal: css`font-size: var(--font-size-base);`,
  comfortable: css`font-size: var(--font-size-lg);`,
};

const TodayValue = styled.span<{ $size: WidgetSize }>`
  color: var(--color-primary);
  font-weight: 600;
  ${(props) => valueSizeStyles[props.$size]}
`;

const NumberRow = styled.div`
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: center;
`;

const buttonSizeStyles = {
  compact: css`
    width: 28px;
    height: 28px;
    font-size: 12px;
    border-radius: 6px;
  `,
  normal: css`
    width: 34px;
    height: 34px;
    font-size: 14px;
    border-radius: 8px;
  `,
  comfortable: css`
    width: 42px;
    height: 42px;
    font-size: 16px;
    border-radius: 8px;
  `,
};

const NumberButton = styled.button<{ $selected?: boolean; $size: WidgetSize }>`
  border: 2px solid ${props => props.$selected ? 'var(--color-primary)' : 'var(--color-border)'};
  background: ${props => props.$selected ? 'var(--color-primary)' : 'var(--color-bg)'};
  color: ${props => props.$selected ? 'white' : 'var(--color-text)'};
  cursor: pointer;
  font-weight: 600;
  ${(props) => buttonSizeStyles[props.$size]}

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

const ExistingEntries = styled.div<{ $size: WidgetSize }>`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-top: var(--space-xs);
  text-align: center;
  ${(props) => props.$size === "compact" && css`display: none;`}
`;

interface RatingWidgetProps {
  widget: RatingWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
  size?: WidgetSize;
}

export function RatingWidget({ widget, entries, userId, logId, timestamp, size = "normal" }: RatingWidgetProps) {
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

  // Get the latest rating for today as stars
  const latestRating = dayEntries.length > 0
    ? (dayEntries[0].data.rating as number)
    : null;
  const latestStars = latestRating ? "★".repeat(latestRating) : null;

  // Format all existing ratings
  const existingRatings = dayEntries.map(e => {
    const rating = e.data.rating as number;
    return "★".repeat(rating);
  });

  return (
    <Card $size={size}>
      <Header $size={size}>
        <Label $size={size}>{widget.label}</Label>
        {latestStars && <TodayValue $size={size}>{latestStars}</TodayValue>}
      </Header>
      <NumberRow>
        {numbers.map((n) => (
          <NumberButton
            key={n}
            $selected={false}
            $size={size}
            disabled={saving || !logId}
            onClick={() => handleRate(n)}
          >
            {n}
          </NumberButton>
        ))}
      </NumberRow>
      {existingRatings.length > 1 && (
        <ExistingEntries $size={size}>
          +{existingRatings.length - 1} more
        </ExistingEntries>
      )}
    </Card>
  );
}
