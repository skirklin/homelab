import { useState } from "react";
import styled, { css } from "styled-components";
import { useFeedback } from "@kirkl/shared";
import type { CounterGroupWidget as CounterGroupWidgetType, LogEntry } from "../../types";
import { getEntriesForDate } from "../../types";
import { useLifeBackend } from "../../backend-provider";
import { type WidgetSize } from "../../display-settings";
import { EntriesPopover } from "./EntriesPopover";

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

const labelSizeStyles = {
  compact: css`font-size: var(--font-size-xs); margin-bottom: var(--space-xs);`,
  normal: css`font-size: var(--font-size-sm); margin-bottom: var(--space-sm);`,
  comfortable: css`font-size: var(--font-size-base); margin-bottom: var(--space-sm);`,
};

const GroupLabel = styled.div<{ $size: WidgetSize }>`
  font-weight: 500;
  color: var(--color-text-secondary);
  ${(props) => labelSizeStyles[props.$size]}
`;

const CountersRow = styled.div<{ $size: WidgetSize }>`
  display: flex;
  flex-wrap: wrap;
  gap: ${(props) => props.$size === "compact" ? "var(--space-xs)" : "var(--space-sm)"};
`;

const buttonSizeStyles = {
  compact: css`
    padding: var(--space-xs) var(--space-sm);
    font-size: var(--font-size-sm);
    min-width: 50px;
  `,
  normal: css`
    padding: var(--space-sm) var(--space-md);
    font-size: var(--font-size-base);
    min-width: 60px;
  `,
  comfortable: css`
    padding: var(--space-sm) var(--space-lg);
    font-size: var(--font-size-lg);
    min-width: 70px;
  `,
};

const CounterButton = styled.button<{ $hasCount: boolean; $size: WidgetSize }>`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  border: 1px solid ${(props) => props.$hasCount ? "var(--color-primary)" : "var(--color-border)"};
  border-radius: var(--radius-md);
  background: ${(props) => props.$hasCount ? "var(--color-primary-light)" : "var(--color-bg)"};
  color: ${(props) => props.$hasCount ? "var(--color-primary)" : "var(--color-text)"};
  cursor: pointer;
  transition: all 0.15s ease;
  font-weight: 500;
  ${(props) => buttonSizeStyles[props.$size]}

  &:hover {
    border-color: var(--color-primary);
    background: var(--color-primary-light);
  }

  &:active {
    transform: scale(0.96);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const badgeSizeStyles = {
  compact: css`
    min-width: 16px;
    height: 16px;
    font-size: 10px;
  `,
  normal: css`
    min-width: 18px;
    height: 18px;
    font-size: 11px;
  `,
  comfortable: css`
    min-width: 20px;
    height: 20px;
    font-size: 12px;
  `,
};

const CountBadge = styled.button<{ $size: WidgetSize }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary);
  color: white;
  border-radius: 999px;
  font-weight: 600;
  padding: 0 4px;
  border: none;
  cursor: pointer;
  ${(props) => badgeSizeStyles[props.$size]}

  &:hover {
    opacity: 0.9;
  }
`;

interface CounterGroupWidgetProps {
  widget: CounterGroupWidgetType;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
  size?: WidgetSize;
}

export function CounterGroupWidget({ widget, entries, userId, logId, timestamp, size = "normal" }: CounterGroupWidgetProps) {
  const { message } = useFeedback();
  const life = useLifeBackend();
  const [savingId, setSavingId] = useState<string | null>(null);

  const handleTap = async (counterId: string) => {
    if (!logId || !userId) return;

    setSavingId(counterId);
    try {
      await life.addEntry(logId, counterId, { count: 1 }, userId, { timestamp });
    } catch (error) {
      console.error("Failed to log:", error);
      message.error("Failed to log");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <Card $size={size}>
      <GroupLabel $size={size}>{widget.label}</GroupLabel>
      <CountersRow $size={size}>
        {widget.counters.map((counter) => {
          const counterEntries = getEntriesForDate(entries, counter.id, timestamp);
          const count = counterEntries.length;
          const isSaving = savingId === counter.id;

          return (
            <CounterButton
              key={counter.id}
              $hasCount={count > 0}
              $size={size}
              onClick={() => handleTap(counter.id)}
              disabled={isSaving || !logId}
            >
              {counter.label}
              {count > 0 && (
                <span onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                  <EntriesPopover entries={counterEntries} logId={logId}>
                    <CountBadge $size={size}>
                      {count}
                    </CountBadge>
                  </EntriesPopover>
                </span>
              )}
            </CounterButton>
          );
        })}
      </CountersRow>
    </Card>
  );
}
