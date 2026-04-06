import { useState, useEffect, useMemo } from "react";
import styled, { css } from "styled-components";
import { message } from "antd";

import type { RatingWidget as RatingWidgetType, LogEntry } from "../../types";
import { getEntriesForDate } from "../../types";
import { addEntry, updateEntry, deleteEntry } from "../../firestore";
import { type WidgetSize } from "../../display-settings";
import { RatingInput } from "./inputs";

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
  const [currentRating, setCurrentRating] = useState<number | null>(null);
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);

  const dayEntries = useMemo(
    () => getEntriesForDate(entries, widget.id, timestamp),
    [entries, widget.id, timestamp]
  );

  // Get first entry's ID and rating for dependency tracking
  const firstEntryId = dayEntries[0]?.id;
  const firstEntryRating = dayEntries[0]?.data?.rating as number | undefined;

  // Sync state from entries
  useEffect(() => {
    if (dayEntries.length > 0 && firstEntryRating !== undefined) {
      setCurrentRating(firstEntryRating);
      setCurrentEntryId(firstEntryId ?? null);
    } else {
      setCurrentRating(null);
      setCurrentEntryId(null);
    }
  }, [dayEntries.length, firstEntryId, firstEntryRating]);

  const handleChange = async (value: number | null) => {
    if (!logId || !userId) return;

    setSaving(true);
    try {
      if (value === null && currentEntryId) {
        // Clear/delete
        await deleteEntry(currentEntryId, logId);
        setCurrentRating(null);
        setCurrentEntryId(null);
      } else if (value !== null && currentEntryId) {
        // Update existing
        await updateEntry(currentEntryId, { data: { rating: value } }, logId);
        setCurrentRating(value);
      } else if (value !== null) {
        // Create new
        await addEntry(widget.id, { rating: value }, userId, { logId, timestamp });
        setCurrentRating(value);
      }
    } catch (error) {
      console.error("Failed to save:", error);
      message.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Format additional entries (after the first)
  const existingRatings = dayEntries.slice(1).map(e => {
    const rating = e.data.rating as number;
    return "★".repeat(rating);
  });

  return (
    <Card $size={size}>
      <Header $size={size}>
        <Label $size={size}>{widget.label}</Label>
      </Header>
      <RatingInput
        value={currentRating}
        onChange={handleChange}
        max={widget.max}
        disabled={saving || !logId}
        size={size}
        allowClear={true}
      />
      {existingRatings.length > 0 && (
        <ExistingEntries $size={size}>
          +{existingRatings.length} more: {existingRatings.join(", ")}
        </ExistingEntries>
      )}
    </Card>
  );
}
