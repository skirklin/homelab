/**
 * Favorites quick-row — the one-tap log surface at the top of the Daily screen.
 *
 * Chips are EXPLICIT FAVORITES only: the pinned `(subjectId, QuickPayload)`
 * actions, in vocab order. There is NO frecency fill — the row is a deliberately
 * curated set the user stars (the ShapeSheet star). A tap replays the exact
 * payload (entries + labels) as a NEW event — logging always appends, and the
 * post-log toast carries Undo (useLogEvent). Each chip carries a small ✕ to
 * un-favorite it inline so the row stays curated without a trip to the sheet.
 *
 * Empty state is a quiet hint (not an empty bar): favorites are opt-in.
 */
import { useCallback, useMemo } from "react";
import styled from "styled-components";
import { CloseOutlined } from "@ant-design/icons";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import type { LifeManifestTrackable, QuickPayload } from "@homelab/backend";
import { pinnedActions, payloadKey, type GlobalAction } from "../lib/frecency";
import { useLogEvent } from "../lib/useLogEvent";
import { useLifeContext } from "../life-context";
import { formatEntry } from "../lib/format";
import { Hint } from "./Hint";

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
`;

const Chip = styled.div`
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--color-primary);
  background: var(--color-primary-light);
  border-radius: 999px;
  overflow: hidden;
  min-height: 34px;
`;

const ChipLog = styled.button`
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  border: none;
  background: transparent;
  border-radius: 999px 0 0 999px;
  padding: 6px 8px 6px 14px;
  font-size: var(--font-size-sm);
  cursor: pointer;
  color: var(--color-text);

  &:disabled { opacity: 0.5; cursor: default; }
`;

const ChipName = styled.span`
  font-weight: 600;
  color: var(--color-text);
`;

const ChipValue = styled.span`
  color: var(--color-text-secondary);
`;

/** Inline un-favorite affordance — a small ✕ on the right of each chip. */
const ChipRemove = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  padding: 0 11px 0 5px;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 10px;

  &:hover { color: var(--color-primary); }
  &:disabled { opacity: 0.4; cursor: default; }
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
  userId: string;
  logId: string | undefined;
  /** If set, log against this timestamp (backfilling a past day). */
  timestamp?: Date;
}

export function GlobalQuickRow({ trackables, userId, logId, timestamp }: GlobalQuickRowProps) {
  const logEvent = useLogEvent();
  const life = useLifeBackend();
  const { message } = useFeedback();
  const { state, dispatch } = useLifeContext();

  const actions = useMemo<GlobalAction[]>(() => pinnedActions(trackables), [trackables]);

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

  // Un-favorite: drop this payload from the trackable's pins and refresh the
  // in-memory manifest (mirrors ShapeSheet's star toggle).
  const unfavorite = useCallback(
    async (action: GlobalAction) => {
      if (!logId) return;
      const { trackable, payload } = action;
      const key = payloadKey(trackable.id, payload);
      const next = (trackable.pinned ?? []).filter((p) => payloadKey(trackable.id, p) !== key);
      try {
        const manifest = await life.updateTrackable(logId, trackable.id, { pinned: next });
        if (state.log) dispatch({ type: "SET_LOG", log: { ...state.log, manifest } });
      } catch (err) {
        console.error("Failed to remove favorite:", err);
        message.error("Couldn't remove favorite");
      }
    },
    [logId, life, state.log, dispatch, message],
  );

  if (actions.length === 0) {
    return (
      <Hint data-testid="favorites-empty">
        No favorites yet — star a value in “+ Log something else” to pin it here.
      </Hint>
    );
  }

  return (
    <Row data-testid="global-quick-row">
      {actions.map((action) => {
        const label = actionValue(action.payload);
        return (
          <Chip key={`p:${payloadKey(action.trackable.id, action.payload)}`}>
            <ChipLog
              disabled={!logId}
              onClick={() => log(action)}
              data-testid="global-quick-chip"
            >
              <ChipName>{action.trackable.label}</ChipName>
              <ChipValue>{label}</ChipValue>
            </ChipLog>
            <ChipRemove
              disabled={!logId}
              aria-label={`Remove favorite ${action.trackable.label} ${label}`}
              onClick={() => unfavorite(action)}
              data-testid="global-quick-remove"
            >
              <CloseOutlined />
            </ChipRemove>
          </Chip>
        );
      })}
    </Row>
  );
}
