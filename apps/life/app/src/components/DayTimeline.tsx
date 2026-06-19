/**
 * Inline "Today" timeline — a compact, chronological peek at what was logged
 * on the viewed day, rendered on the dashboard directly below the shape grid.
 * It swipes with the day (lives inside <SwipeContainer>) so it tracks
 * `selectedDate`, not always "today".
 *
 * It is a READ surface plus a tap that opens the unified edit modal:
 * tapping an event's row opens `EventsEditModal` on that one event (edit
 * timestamp/values, or delete). Session rows are non-interactive (they're
 * composite prompt entries, not single-shape events); deleted-vocab rows ARE
 * editable — the event still has entries worth editing/deleting. The full
 * Journal lives at /journal; the footer links there.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import dayjs from "dayjs";
import type { LifeEvent, LifeManifestTrackable, SessionView } from "@homelab/backend";
import { normalizeSessionRuns } from "@homelab/backend";
import {
  aggregateEvents,
  eventsForDay,
  formatAggregate,
  labelFor,
} from "../lib/shapes";
import { userTz } from "../lib/useUserTz";
import { EventsEditModal } from "./EventsEditModal";

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

const Wrap = styled.div`
  margin-top: var(--space-md);
`;

const Header = styled.div`
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: var(--space-xs);
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-bg);
`;

const Row = styled.button<{ $interactive: boolean }>`
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
  width: 100%;
  text-align: left;
  padding: var(--space-sm) var(--space-md);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text);
  cursor: ${(p) => (p.$interactive ? "pointer" : "default")};

  &:last-child {
    border-bottom: none;
  }

  &:hover {
    background: ${(p) => (p.$interactive ? "var(--color-bg-muted)" : "transparent")};
  }
`;

const Time = styled.span`
  flex-shrink: 0;
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
  min-width: 64px;
`;

const Thing = styled.span`
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--color-text);
`;

const Value = styled.span`
  flex: 1;
  font-size: var(--font-size-base);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Footer = styled.button`
  width: 100%;
  text-align: center;
  padding: var(--space-sm);
  background: transparent;
  border: none;
  border-top: 1px solid var(--color-border);
  color: var(--color-primary);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;

  &:hover {
    background: var(--color-bg-muted);
  }
`;

const EmptyHint = styled.div`
  font-size: var(--font-size-sm);
  font-style: italic;
  color: var(--color-text-muted, var(--color-text-secondary));
  padding: var(--space-xs) 0;
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Max event rows before collapsing the remainder into a "+N more" footer. */
const MAX_ROWS = 7;

/** Human title for a normalized run's view id (per-item runs key on `view`). */
const VIEW_TITLE: Record<SessionView, string> = {
  morning: "Morning",
  evening: "Evening",
  weekly: "Weekly review",
};

function formatTime(d: Date): string {
  return dayjs(d).format("h:mm A");
}

interface TimelineRow {
  id: string;
  time: string;
  /** Sort key (ms) — not rendered; keeps rows newest-first across mixed sources. */
  ts: number;
  thing: string;
  value: string;
  /**
   * The event to open in the edit modal on tap; null for session rows, which
   * stay non-interactive (composite prompt entries, not single-shape events).
   */
  event: LifeEvent | null;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DayTimelineProps {
  trackables: LifeManifestTrackable[];
  events: LifeEvent[];
  /** The day being viewed (start of day). */
  day: Date;
  /** Pre-computed `journal[?date=…]` target reused for the "+N more" / footer. */
  journalTarget: string;
}

export function DayTimeline({
  trackables,
  events,
  day,
  journalTarget,
}: DayTimelineProps) {
  const navigate = useNavigate();
  // Self-contained edit-modal state: tapping an event row opens it for that one
  // event. The backend (via EntriesList) handles the write; the subscription
  // refreshes this list.
  const [editing, setEditing] = useState<LifeEvent | null>(null);

  // Header text: "Today's log" for the current day, else the day's label +
  // " log" (Journal phrasing: Yesterday / "Mon, May 5"). The " log" suffix
  // keeps this from colliding with the bare date label the date-nav above
  // already shows — repeating it verbatim would be visual noise.
  const headerText = useMemo(() => {
    const today = new Date();
    if (isSameDay(day, today)) return "Today's log";
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (isSameDay(day, yesterday)) return "Yesterday's log";
    return `${dayjs(day).format("ddd, MMM D")} log`;
  }, [day]);

  const viewingToday = useMemo(() => isSameDay(day, new Date()), [day]);

  // One row per event on the viewed day, newest first (eventsForDay already
  // sorts that way — same ordering as the Journal). Text/notes-only entries
  // (sessions excepted) are kept terse: their per-thing value summary is empty,
  // which the cards already do, so the row just shows the label.
  const tz = userTz();
  const rows = useMemo<TimelineRow[]>(() => {
    const dayEvents = eventsForDay(events, day, tz);

    // A session run is N per-item events correlated by labels.view/view_run.
    // Normalize the day to uniform runs, then render each run as ONE
    // non-interactive session row. Per-item children are collapsed into that
    // row, so they must NOT also render as individual editable event rows below.
    const runs = normalizeSessionRuns(dayEvents);
    const perItemChildIds = new Set<string>();
    for (const ev of dayEvents) {
      if (ev.labels?.view && ev.labels?.view_run) perItemChildIds.add(ev.id);
    }

    const sessionRows: TimelineRow[] = runs.map((run) => ({
      id: run.id,
      time: formatTime(run.timestamp),
      ts: run.timestamp.getTime(),
      thing: `${VIEW_TITLE[run.view]} session`,
      value: "",
      event: null,
    }));

    const eventRows: TimelineRow[] = [];
    for (const ev of dayEvents) {
      // Per-item run children are folded into their session row above; skip.
      if (perItemChildIds.has(ev.id)) continue;
      // Every other event is editable — including deleted-vocab rows, which
      // still carry entries worth editing/deleting and degrade to the raw id.
      eventRows.push({
        id: ev.id,
        time: formatTime(ev.timestamp),
        ts: ev.timestamp.getTime(),
        thing: labelFor(trackables, ev.subjectId),
        // Single-event summary — reuses the same formatting as the cards.
        value: formatAggregate(aggregateEvents([ev])),
        event: ev,
      });
    }

    // Newest first, matching eventsForDay's ordering (sessions interleave by
    // their run timestamp).
    return [...sessionRows, ...eventRows].sort((a, b) => b.ts - a.ts);
  }, [events, day, trackables, tz]);

  const visible = rows.slice(0, MAX_ROWS);
  const overflow = rows.length - visible.length;

  return (
    <Wrap data-testid="day-timeline">
      <Header>{headerText}</Header>
      {rows.length === 0 ? (
        <EmptyHint data-testid="day-timeline-empty">
          {viewingToday ? "Nothing logged today" : "Nothing logged this day"}
        </EmptyHint>
      ) : (
        <List>
          {visible.map((r) => (
            <Row
              key={r.id}
              $interactive={r.event !== null}
              disabled={r.event === null}
              data-testid="day-timeline-row"
              onClick={r.event ? () => setEditing(r.event) : undefined}
            >
              <Time>{r.time}</Time>
              <Thing>{r.thing}</Thing>
              {r.value && <Value>{r.value}</Value>}
            </Row>
          ))}
          <Footer
            data-testid="day-timeline-footer"
            onClick={() => navigate(journalTarget)}
          >
            {overflow > 0 ? `+${overflow} more · See all in Journal` : "See all in Journal"}
          </Footer>
        </List>
      )}
      <EventsEditModal
        events={editing ? [editing] : null}
        trackables={trackables}
        onClose={() => setEditing(null)}
      />
    </Wrap>
  );
}
