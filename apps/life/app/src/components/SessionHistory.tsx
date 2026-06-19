/**
 * Session-history drill-down — a bottom Drawer (mirroring HabitHistory's chrome)
 * opened from the Sessions section header. It surfaces the 8-week
 * morning/evening/weekly completion grid (`SessionStreakGrid`) as a drill-down,
 * the same way tapping a trackable's name on the HabitBoard opens HabitHistory.
 *
 * The grid is a pure completion-history view (no interactions); this wrapper
 * only supplies the Drawer chrome + a one-line caption. Kept intentionally
 * lighter than HabitHistory: no month pagination, no per-period stats — the
 * split-cell grid already carries its own legend.
 */
import { Drawer } from "antd";
import styled from "styled-components";
import type { LifeEvent } from "@homelab/backend";
import { SessionStreakGrid } from "./SessionStreakGrid";

const Caption = styled.p`
  margin: 0 0 var(--space-md);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`;

export interface SessionHistoryProps {
  open: boolean;
  onClose: () => void;
  /** All of the user's life events — the grid buckets runs by tz-aware day. */
  events: LifeEvent[];
  /** User's IANA tz — buckets day identity to match the rest of the app. */
  tz: string;
}

export function SessionHistory({ open, onClose, events, tz }: SessionHistoryProps) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="bottom"
      height="auto"
      title="Session history"
      destroyOnClose
      data-testid="session-history"
      styles={{ body: { padding: "var(--space-md)" } }}
    >
      <Caption>
        Last 8 weeks — each cell splits morning (top) and evening (bottom);
        Sundays show the weekly review.
      </Caption>
      <SessionStreakGrid entries={events} tz={tz} />
    </Drawer>
  );
}
