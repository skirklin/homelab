/**
 * The four event-recording shapes (took / did / happened / rated) and the
 * generic, NAME-AGNOSTIC event readers that go with them.
 *
 * Construction (new events) is canonical per shape:
 *   took     → [{name:"amount",   type:"number", value, unit}]
 *   did      → [{name:"duration", type:"number", value, unit:"min"},
 *               optional {name:"rating", unit:"rating", scale:5},
 *               optional {name:"notes", type:"text"}]
 *   happened → [{name:"count",    type:"number", value:1, unit:"ct"}]
 *   rated    → [{name:"rating",   type:"number", value, unit:"rating", scale:N}]
 *
 * Reading is generic: history predates the shape model and uses old entry
 * names (dose, volume, drinks, intensity, …), so aggregation/trends/history
 * read "the number entries" — sum non-rating numbers per unit, average
 * rating-unit entries — and NEVER look entries up by name.
 */
import type {
  LifeEvent,
  LifeEntry,
  LifeManifestTrackable,
  TrackableShape,
} from "@homelab/backend";
import { formatDuration, formatRating } from "./format";

export const SHAPE_ORDER: TrackableShape[] = ["took", "did", "happened", "rated"];

export const SHAPE_META: Record<TrackableShape, { title: string; hint: string }> = {
  took: { title: "Took", hint: "doses, drinks, pills…" },
  did: { title: "Did", hint: "exercise, focus, sleep…" },
  happened: { title: "Happened", hint: "one-tap counters" },
  rated: { title: "Rated", hint: "mood, energy…" },
};

// ---------------------------------------------------------------------------
// Shape → entries construction
// ---------------------------------------------------------------------------

/** Form values a shape sheet collects. Only the shape-relevant keys are read. */
export interface ShapeFormValues {
  /** took */
  amount?: number | null;
  unit?: string;
  /** did */
  duration?: number | null;
  /** did (optional companion) + rated (required) */
  rating?: number | null;
  /** rated: top of the scale (default 5) */
  scale?: number;
  /** did (optional) */
  notes?: string;
}

/**
 * Build the canonical entries[] for a new event of `shape` from form values.
 * Returns null when the required value for the shape is missing/invalid —
 * callers surface "enter a value" instead of writing a junk event.
 */
export function buildEntries(shape: TrackableShape, values: ShapeFormValues): LifeEntry[] | null {
  switch (shape) {
    case "took": {
      const v = values.amount;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
      return [{ name: "amount", type: "number", value: v, unit: values.unit || "ct" }];
    }
    case "did": {
      const d = values.duration;
      if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) return null;
      const out: LifeEntry[] = [{ name: "duration", type: "number", value: d, unit: "min" }];
      const r = values.rating;
      if (typeof r === "number" && Number.isFinite(r) && r >= 1) {
        out.push({ name: "rating", type: "number", value: r, unit: "rating", scale: 5 });
      }
      const notes = (values.notes ?? "").trim();
      if (notes) out.push({ name: "notes", type: "text", value: notes });
      return out;
    }
    case "happened":
      return [{ name: "count", type: "number", value: 1, unit: "ct" }];
    case "rated": {
      const r = values.rating;
      const scale = values.scale ?? 5;
      if (typeof r !== "number" || !Number.isFinite(r) || r < 1 || r > scale) return null;
      return [{ name: "rating", type: "number", value: r, unit: "rating", scale }];
    }
  }
}

// ---------------------------------------------------------------------------
// Generic (name-agnostic) aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate a set of events generically: sum every non-rating number entry
 * per unit; average every rating-unit entry. No entry-name lookups, so
 * historical names (dose/volume/drinks/intensity) aggregate identically to
 * canonical ones (amount/duration/count/rating).
 */
export interface GenericAggregate {
  /** Sum of non-rating number values, keyed by unit, in first-seen order. */
  sums: Map<string, number>;
  /** Average of rating-unit values (1 decimal), or null when none. */
  ratingAvg: number | null;
  ratingCount: number;
  /** Scale of the first rating entry seen (display hint). */
  ratingScale: number;
  eventCount: number;
}

export function aggregateEvents(events: LifeEvent[]): GenericAggregate {
  const sums = new Map<string, number>();
  let ratingTotal = 0;
  let ratingCount = 0;
  let ratingScale = 5;
  for (const ev of events) {
    for (const e of ev.entries) {
      if (e.type !== "number") continue;
      if (e.unit === "rating") {
        ratingTotal += e.value;
        if (ratingCount === 0 && typeof e.scale === "number") ratingScale = e.scale;
        ratingCount += 1;
      } else {
        sums.set(e.unit, (sums.get(e.unit) ?? 0) + e.value);
      }
    }
  }
  return {
    sums,
    ratingAvg: ratingCount > 0 ? Math.round((ratingTotal / ratingCount) * 10) / 10 : null,
    ratingCount,
    ratingScale,
    eventCount: events.length,
  };
}

/** Format one unit+value pair for display ("1h 30m", "×3", "30 mg", "4/5"). */
export function formatUnitValue(value: number, unit: string): string {
  if (unit === "min") return formatDuration(value);
  if (unit === "ct") return `×${value}`;
  if (unit === "rating") return formatRating(value);
  return `${value} ${unit}`;
}

/**
 * One-line summary of a generic aggregate ("16 oz", "1h 10m · 4/5", "×3").
 * The dominant (first-seen) unit leads; a rating average is appended when
 * present. Returns "" when the aggregate is empty.
 */
export function formatAggregate(agg: GenericAggregate): string {
  const parts: string[] = [];
  const first = agg.sums.entries().next();
  if (!first.done) {
    const [unit, value] = first.value;
    parts.push(formatUnitValue(Math.round(value * 100) / 100, unit));
  }
  if (agg.ratingAvg !== null) {
    parts.push(formatRating(agg.ratingAvg, agg.ratingScale));
  }
  return parts.join(" · ");
}

/**
 * A single scalar for charting a thing's day: the dominant-unit sum when one
 * exists, else the rating average, else the event count. `unit` describes
 * which scalar was chosen so axis labels stay honest.
 */
export function eventScalar(events: LifeEvent[]): { value: number; unit: string } | null {
  if (events.length === 0) return null;
  const agg = aggregateEvents(events);
  const first = agg.sums.entries().next();
  if (!first.done) {
    const [unit, value] = first.value;
    return { value, unit };
  }
  if (agg.ratingAvg !== null) return { value: agg.ratingAvg, unit: "rating" };
  return { value: events.length, unit: "ct" };
}

// ---------------------------------------------------------------------------
// Vocab helpers
// ---------------------------------------------------------------------------

/** Vocab rows of one shape (hidden ones excluded), in manifest order. */
export function thingsOfShape(
  trackables: LifeManifestTrackable[],
  shape: TrackableShape,
): LifeManifestTrackable[] {
  return trackables.filter((t) => t.shape === shape && !t.hidden);
}

/**
 * Resolve a display label for a subjectId: the vocab row's label when one
 * exists, else the raw id (events whose vocab row was removed must still
 * display — degrade, don't drop).
 */
export function labelFor(trackables: LifeManifestTrackable[], subjectId: string): string {
  return trackables.find((t) => t.id === subjectId)?.label ?? subjectId;
}

// ---------------------------------------------------------------------------
// Day filtering (shared by cards/sheets)
// ---------------------------------------------------------------------------

export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

/** Events for one subject on one day (default today), newest first. */
export function eventsForThing(events: LifeEvent[], subjectId: string, day?: Date): LifeEvent[] {
  const date = day ?? new Date();
  const lo = startOfDay(date);
  const hi = endOfDay(date);
  return events
    .filter((e) => e.subjectId === subjectId && e.timestamp >= lo && e.timestamp <= hi)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}

/** All events on one day, newest first. */
export function eventsForDay(events: LifeEvent[], day?: Date): LifeEvent[] {
  const date = day ?? new Date();
  const lo = startOfDay(date);
  const hi = endOfDay(date);
  return events
    .filter((e) => e.timestamp >= lo && e.timestamp <= hi)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}
