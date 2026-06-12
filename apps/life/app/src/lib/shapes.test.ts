/**
 * Shape model: canonical entries[] construction for NEW events and the
 * generic (name-agnostic) readers used by cards/sheets/trends.
 *
 * Construction must emit exactly the canonical shapes:
 *   took     → [{name:"amount",   value, unit}]
 *   did      → [{name:"duration", value, unit:"min"}, ?rating, ?notes]
 *   happened → [{name:"count",    value:1, unit:"ct"}]
 *   rated    → [{name:"rating",   value, unit:"rating", scale:N}]
 *
 * Reading must be name-agnostic: history predates the shape model (entry
 * names dose/volume/drinks/intensity), so aggregation keys on unit only.
 */
import { describe, it, expect } from "vitest";
import type { LifeEvent, LifeManifestTrackable } from "@homelab/backend";
import {
  buildEntries,
  aggregateEvents,
  formatAggregate,
  formatUnitValue,
  eventScalar,
  thingsOfShape,
  labelFor,
  eventsForThing,
} from "./shapes";

let counter = 0;
function ev(subjectId: string, entries: LifeEvent["entries"], ts: Date): LifeEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    log: "log1",
    subjectId,
    timestamp: ts,
    entries,
    createdBy: "u1",
    created: ts.toISOString(),
    updated: ts.toISOString(),
  };
}

describe("buildEntries", () => {
  it("took → single amount entry with the chosen unit", () => {
    expect(buildEntries("took", { amount: 30, unit: "mg" })).toEqual([
      { name: "amount", type: "number", value: 30, unit: "mg" },
    ]);
  });

  it("took without a unit falls back to ct; invalid amount → null", () => {
    expect(buildEntries("took", { amount: 2 })).toEqual([
      { name: "amount", type: "number", value: 2, unit: "ct" },
    ]);
    expect(buildEntries("took", { amount: 0, unit: "mg" })).toBeNull();
    expect(buildEntries("took", {})).toBeNull();
  });

  it("did → duration in canonical minutes, plus optional rating and notes", () => {
    expect(buildEntries("did", { duration: 30 })).toEqual([
      { name: "duration", type: "number", value: 30, unit: "min" },
    ]);
    expect(buildEntries("did", { duration: 480, rating: 4, notes: "  solid night " })).toEqual([
      { name: "duration", type: "number", value: 480, unit: "min" },
      { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
      { name: "notes", type: "text", value: "solid night" },
    ]);
    expect(buildEntries("did", { rating: 4 })).toBeNull(); // duration required
  });

  it("happened → count 1 ct, always", () => {
    expect(buildEntries("happened", {})).toEqual([
      { name: "count", type: "number", value: 1, unit: "ct" },
    ]);
  });

  it("rated → rating entry with scale; out-of-range → null", () => {
    expect(buildEntries("rated", { rating: 4 })).toEqual([
      { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
    ]);
    expect(buildEntries("rated", { rating: 9, scale: 10 })).toEqual([
      { name: "rating", type: "number", value: 9, unit: "rating", scale: 10 },
    ]);
    expect(buildEntries("rated", { rating: 6 })).toBeNull();
    expect(buildEntries("rated", {})).toBeNull();
  });
});

describe("aggregateEvents (generic, name-agnostic)", () => {
  it("sums non-rating numbers per unit even under historical entry names", () => {
    const events = [
      ev("coffee", [{ name: "volume", type: "number", value: 8, unit: "oz" }], new Date()),
      ev("coffee", [{ name: "amount", type: "number", value: 12, unit: "oz" }], new Date()),
    ];
    const agg = aggregateEvents(events);
    expect(agg.sums.get("oz")).toBe(20);
    expect(agg.ratingAvg).toBeNull();
    expect(agg.eventCount).toBe(2);
  });

  it("averages rating-unit entries regardless of name (intensity vs rating)", () => {
    const events = [
      ev("exercise", [
        { name: "duration", type: "number", value: 30, unit: "min" },
        { name: "intensity", type: "number", value: 3, unit: "rating", scale: 5 },
      ], new Date()),
      ev("exercise", [
        { name: "duration", type: "number", value: 60, unit: "min" },
        { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
      ], new Date()),
    ];
    const agg = aggregateEvents(events);
    expect(agg.sums.get("min")).toBe(90);
    expect(agg.ratingAvg).toBe(3.5);
    expect(agg.ratingCount).toBe(2);
  });

  it("formatAggregate renders dominant unit then rating avg", () => {
    const events = [
      ev("sleep", [
        { name: "duration", type: "number", value: 450, unit: "min" },
        { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
      ], new Date()),
    ];
    expect(formatAggregate(aggregateEvents(events))).toBe("7h 30m · 4/5");
  });

  it("formatUnitValue formats min/ct/rating/other", () => {
    expect(formatUnitValue(90, "min")).toBe("1h 30m");
    expect(formatUnitValue(3, "ct")).toBe("×3");
    expect(formatUnitValue(4, "rating")).toBe("4/5");
    expect(formatUnitValue(30, "mg")).toBe("30 mg");
  });

  it("eventScalar picks dominant-unit sum, else rating avg, else count", () => {
    const t = new Date();
    expect(eventScalar([ev("a", [{ name: "x", type: "number", value: 5, unit: "mg" }], t)]))
      .toEqual({ value: 5, unit: "mg" });
    expect(eventScalar([ev("a", [{ name: "r", type: "number", value: 4, unit: "rating" }], t)]))
      .toEqual({ value: 4, unit: "rating" });
    expect(eventScalar([ev("a", [{ name: "n", type: "text", value: "hi" }], t)]))
      .toEqual({ value: 1, unit: "ct" });
    expect(eventScalar([])).toBeNull();
  });
});

describe("vocab helpers", () => {
  const vocab: LifeManifestTrackable[] = [
    { id: "coffee", label: "Coffee", shape: "took", defaultUnit: "oz" },
    { id: "run", label: "Run", shape: "did", group: "exercise" },
    { id: "secret", label: "Secret", shape: "took", hidden: true },
    { id: "mood", label: "Mood", shape: "rated" },
  ];

  it("thingsOfShape filters by shape and excludes hidden", () => {
    expect(thingsOfShape(vocab, "took").map((t) => t.id)).toEqual(["coffee"]);
    expect(thingsOfShape(vocab, "did").map((t) => t.id)).toEqual(["run"]);
  });

  it("labelFor degrades unknown subjectIds to the raw id", () => {
    expect(labelFor(vocab, "coffee")).toBe("Coffee");
    expect(labelFor(vocab, "deleted-thing")).toBe("deleted-thing");
  });

  it("eventsForThing filters by subject and day, newest first", () => {
    // Pin the reference instant to noon so the "2 hours earlier" event can
    // never slip across midnight regardless of when the suite runs.
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const earlier = new Date(today.getTime() - 2 * 60 * 60 * 1000);
    const events = [
      ev("coffee", [{ name: "amount", type: "number", value: 8, unit: "oz" }], earlier),
      ev("coffee", [{ name: "amount", type: "number", value: 12, unit: "oz" }], today),
      ev("coffee", [{ name: "amount", type: "number", value: 16, unit: "oz" }], yesterday),
      ev("mood", [{ name: "rating", type: "number", value: 3, unit: "rating" }], today),
    ];
    const out = eventsForThing(events, "coffee", today);
    expect(out.map((e) => e.entries[0].value)).toEqual([12, 8]);
  });
});
