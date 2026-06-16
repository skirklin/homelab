/**
 * Compact summary card for one shape (Took / Did / Happened / Rated): the
 * things of that shape logged on the viewed day, one line each. Tapping the
 * card opens the shape's bottom sheet (the actual logging surface).
 *
 * Unknown subjectIds (events whose vocab row was deleted) have no shape, so
 * they don't appear here — Journal/Insights still show them.
 */
import { useMemo } from "react";
import styled from "styled-components";
import type { LifeEvent, LifeManifestTrackable, TrackableShape } from "@homelab/backend";
import {
  SHAPE_META,
  aggregateEvents,
  eventsForDay,
  formatAggregate,
} from "../lib/shapes";
import { userTz } from "../lib/useUserTz";

const Card = styled.button<{ $active: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-xs);
  padding: var(--space-sm);
  background: var(--color-bg);
  border: 2px solid ${(p) => (p.$active ? "var(--color-primary)" : "var(--color-border)")};
  border-radius: var(--radius-lg);
  cursor: pointer;
  text-align: left;
  min-height: 96px;

  &:hover { border-color: var(--color-primary); }
`;

const Title = styled.span`
  font-weight: 600;
  font-size: var(--font-size-base);
  color: var(--color-text);
`;

const SummaryLine = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const EmptyHint = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-muted, var(--color-text-secondary));
  font-style: italic;
`;

/** Max per-thing summary lines before collapsing into "+N more". */
const MAX_LINES = 3;

export interface ShapeCardProps {
  shape: TrackableShape;
  trackables: LifeManifestTrackable[];
  events: LifeEvent[];
  /** The day being viewed (start of day). */
  day: Date;
  onOpen: (shape: TrackableShape) => void;
}

export function ShapeCard({ shape, trackables, events, day, onOpen }: ShapeCardProps) {
  const meta = SHAPE_META[shape];

  // Summaries: every thing of THIS shape with events on the viewed day —
  // including hidden vocab rows (a logged fact stays visible even if the
  // thing is hidden from the input surfaces).
  const tz = userTz();
  const lines = useMemo(() => {
    const shapeIds = new Map(
      trackables.filter((t) => t.shape === shape).map((t) => [t.id, t.label]),
    );
    const byThing = new Map<string, LifeEvent[]>();
    for (const ev of eventsForDay(events, day, tz)) {
      if (!shapeIds.has(ev.subjectId)) continue;
      const list = byThing.get(ev.subjectId);
      if (list) list.push(ev);
      else byThing.set(ev.subjectId, [ev]);
    }
    return [...byThing.entries()].map(([id, evs]) => {
      const summary = formatAggregate(aggregateEvents(evs));
      return { id, text: `${shapeIds.get(id)}${summary ? ` ${summary}` : ""}` };
    });
  }, [trackables, events, shape, day, tz]);

  return (
    <Card $active={lines.length > 0} onClick={() => onOpen(shape)} data-testid={`shape-card-${shape}`}>
      <Title>{meta.title}</Title>
      {lines.length === 0 ? (
        <EmptyHint>{meta.hint}</EmptyHint>
      ) : (
        <>
          {lines.slice(0, MAX_LINES).map((l) => (
            <SummaryLine key={l.id}>{l.text}</SummaryLine>
          ))}
          {lines.length > MAX_LINES && <SummaryLine>+{lines.length - MAX_LINES} more</SummaryLine>}
        </>
      )}
    </Card>
  );
}
