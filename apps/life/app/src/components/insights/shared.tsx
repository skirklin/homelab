/**
 * Chrome shared across the three Insights views: layout primitives, the
 * series-distribution color ramp (percentile → fill), and the day drill-down
 * hook that opens the existing `EventsEditModal` for a tapped bucket.
 */
import { useMemo, useState, useCallback } from "react";
import styled from "styled-components";
import type { LifeEvent, LifeManifestTrackable } from "@homelab/backend";
import { startOfDay, endOfDay } from "@homelab/backend";
import type { LogEvent } from "../../types";
import { EventsEditModal } from "../EventsEditModal";

// The series brand color, threaded through the percentile ramp so a "big day"
// for a thing reads as a deep fill and a small one as a faint tint.
export const SERIES_COLORS = ["#7c3aed", "#0ea5e9", "#f59e0b"];

export const Controls = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-md);
  margin-bottom: var(--space-lg);
  flex-wrap: wrap;
`;

export const ChartBox = styled.div`
  height: 320px;
  margin: var(--space-md) 0;
`;

export const Hint = styled.p`
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  text-align: center;
  margin: var(--space-lg) 0;
`;

export const ReadOut = styled.div`
  text-align: center;
  margin: var(--space-md) 0;
  font-size: var(--font-size-md);
  color: var(--color-text);
`;

/**
 * Percentile → rgba fill on `base`. A value at the top of the thing's own
 * distribution (percentile 1) reads at full strength; the floor stays faintly
 * visible (min 0.18) so a "logged but small" day isn't invisible.
 */
export function rampColor(base: string, pct: number): string {
  const { r, g, b } = hexToRgb(base);
  const alpha = 0.18 + Math.min(Math.max(pct, 0), 1) * 0.82;
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * Drill-down: hand back an `openRange(from, to, subjectIds)` opener and the
 * modal node. Tapping a bar/point/cell resolves the events for the relevant
 * subjects within that bucket's LOCAL day range (tz-correct bounds) and opens
 * the shared editor — the same modal the calendar and journal use, so
 * editing/deleting flows identically. A single day passes from === to.
 */
export function useDrillDown(allEntries: LogEvent[], trackables: LifeManifestTrackable[], tz: string) {
  const [events, setEvents] = useState<LifeEvent[] | null>(null);

  const openRange = useCallback(
    (from: Date, to: Date, subjectIds: string[]) => {
      const lo = startOfDay(from, tz);
      const hi = endOfDay(to, tz);
      const subjects = new Set(subjectIds);
      const matched = allEntries
        .filter((e) => subjects.has(e.subjectId) && e.timestamp >= lo && e.timestamp <= hi)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      if (matched.length > 0) setEvents(matched);
    },
    [allEntries, tz],
  );

  const modal = useMemo(
    () => <EventsEditModal events={events} trackables={trackables} onClose={() => setEvents(null)} />,
    [events, trackables],
  );

  return { openRange, modal };
}
