/**
 * Global quick-row — the PRIMARY input surface at the top of the dashboard.
 *
 * Chips are replayable (subjectId, payload) actions: ALL pins (vocab order,
 * never trimmed) then global frecency fills to ~8. A tap replays the exact
 * payload (entries + labels) as a NEW event — logging always appends, and the
 * post-log toast carries Undo (useLogEvent). Text/notes entries never ride in
 * a chip (excluded from frecency keys and replay).
 */
import { useMemo } from "react";
import styled from "styled-components";
import type { LifeManifestTrackable, QuickPayload, LifeEvent } from "@homelab/backend";
import { globalFrecentActions, type GlobalAction } from "../lib/frecency";
import { useLogEvent } from "../lib/useLogEvent";
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
  padding: 5px 13px;
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

/** Value-only label for the action ("5 mg", "8 oz · run"). */
function actionValue(payload: QuickPayload): string {
  if (payload.label) return payload.label;
  const measured = payload.entries.filter((e) => e.type !== "text");
  const valuePart = measured.map(formatEntry).join(" ");
  const cat = payload.labels ? Object.values(payload.labels)[0] : undefined;
  return cat ? `${valuePart} · ${cat}` : valuePart;
}

interface GlobalQuickRowProps {
  trackables: LifeManifestTrackable[];
  events: LifeEvent[];
  userId: string;
  logId: string | undefined;
  /** If set, log against this timestamp (backfilling a past day). */
  timestamp?: Date;
  /** Target chip count (pins always all render; frecency fills to this). */
  limit?: number;
}

export function GlobalQuickRow({ trackables, events, userId, logId, timestamp, limit = 8 }: GlobalQuickRowProps) {
  const logEvent = useLogEvent();

  const actions = useMemo<GlobalAction[]>(
    () => globalFrecentActions(events, trackables, { limit }),
    [events, trackables, limit],
  );

  const log = async (action: GlobalAction) => {
    if (!logId || !userId) return;
    await logEvent({
      logId,
      userId,
      subjectId: action.trackable.id,
      entries: action.payload.entries,
      labels: action.payload.labels,
      timestamp,
      label: `${action.trackable.label} ${actionValue(action.payload)}`.trim(),
    });
  };

  if (actions.length === 0) return null;

  return (
    <Row data-testid="global-quick-row">
      {actions.map((action) => (
        <Chip
          key={`${action.trackable.id}:${actionValue(action.payload)}`}
          $pinned={action.pinned}
          disabled={!logId}
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
