/**
 * Cross-trackable quick-log row (P3). Replaces the lost PWA home-screen
 * jumplist with an in-app one: the most-frecent actions + pins across all
 * (non-hidden) trackables, one tap to log. Compact and unobtrusive — it sits
 * above the per-trackable grid and quietly renders nothing when there's no
 * history and no pins yet (a fresh log).
 *
 * Each chip shows the trackable label + the action's value ("Edibles 5mg",
 * "Coffee 8 oz · ...") so it's unambiguous which trackable a tap targets.
 */
import { useCallback, useMemo, useState } from "react";
import styled from "styled-components";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import type { LifeManifestTrackable, QuickPayload } from "@homelab/backend";
import type { LogEntry } from "../types";
import { globalFrecentActions, type GlobalAction } from "../lib/frecency";
import { formatEntry } from "../lib/format";

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--space-sm);
`;

const Chip = styled.button<{ $pinned: boolean }>`
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  border: 1px solid ${(p) => (p.$pinned ? "var(--color-primary)" : "var(--color-border)")};
  background: ${(p) => (p.$pinned ? "var(--color-primary-light)" : "var(--color-bg)")};
  border-radius: 999px;
  padding: 4px 12px;
  font-size: var(--font-size-xs);
  cursor: pointer;
  color: var(--color-text);

  &:hover { border-color: var(--color-primary); }
  &:disabled { opacity: 0.5; cursor: default; }
`;

const ChipName = styled.span`
  font-weight: 600;
  color: var(--color-text);
`;

const ChipValue = styled.span`
  color: var(--color-text-secondary);
`;

/** Value-only label for the action ("5mg", "8 oz · run"). */
function actionValue(payload: QuickPayload): string {
  if (payload.label) return payload.label;
  const measured = payload.entries.filter((e) => e.type === "number" || e.type === "bool");
  const valuePart = measured.map(formatEntry).join(" ");
  const cat = payload.labels ? Object.values(payload.labels)[0] : undefined;
  return cat ? `${valuePart} · ${cat}` : valuePart;
}

interface GlobalQuickRowProps {
  trackables: LifeManifestTrackable[];
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  /** If set, log against this timestamp (backfilling a past day). */
  timestamp?: Date;
  /** Max chips. */
  limit?: number;
}

export function GlobalQuickRow({ trackables, entries, userId, logId, timestamp, limit = 6 }: GlobalQuickRowProps) {
  const { message } = useFeedback();
  const life = useLifeBackend();
  const [saving, setSaving] = useState(false);

  const actions = useMemo<GlobalAction[]>(
    () => globalFrecentActions(entries, trackables, { limit }),
    [entries, trackables, limit],
  );

  const log = useCallback(async (action: GlobalAction) => {
    if (!logId || !userId) return;
    setSaving(true);
    try {
      await life.addEvent(logId, action.trackable.id, action.payload.entries, userId, {
        timestamp,
        labels: action.payload.labels,
      });
      message.success(`Logged ${action.trackable.label}`);
    } catch (err) {
      console.error("Quick-log failed:", err);
      message.error("Failed to log");
    } finally {
      setSaving(false);
    }
  }, [logId, userId, timestamp, life, message]);

  if (actions.length === 0) return null;

  return (
    <Row data-testid="global-quick-row">
      {actions.map((action) => (
        <Chip
          key={`${action.trackable.id}:${actionValue(action.payload)}`}
          $pinned={action.pinned}
          disabled={saving || !logId}
          onClick={() => log(action)}
          data-testid="global-quick-chip"
        >
          <ChipName>{action.trackable.label}</ChipName>
          <ChipValue>{actionValue(action.payload)}</ChipValue>
        </Chip>
      ))}
    </Row>
  );
}
