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
import { dayKey, zonedDateTime } from "@homelab/backend";
import {
  buildEntries,
  aggregateEvents,
  formatAggregate,
  formatUnitValue,
  eventScalar,
  thingsOfShape,
  labelFor,
  eventsForThing,
  eventsForDay,
  isReflective,
  isInputEligible,
  SHAPE_ORDER,
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

  it("noted → single text `note` entry; blank/absent → null", () => {
    expect(buildEntries("noted", { text: "grateful for the rain" })).toEqual([
      { name: "note", type: "text", value: "grateful for the rain" },
    ]);
    // trims, and a whitespace-only / empty / absent body is rejected so we
    // never write an empty entries[] (PB addEvent rejects it).
    expect(buildEntries("noted", { text: "  trimmed  " })).toEqual([
      { name: "note", type: "text", value: "trimmed" },
    ]);
    expect(buildEntries("noted", { text: "   " })).toBeNull();
    expect(buildEntries("noted", { text: "" })).toBeNull();
    expect(buildEntries("noted", {})).toBeNull();
  });
});

describe("input-surface exclusion invariant (noted)", () => {
  const vocab: LifeManifestTrackable[] = [
    { id: "coffee", label: "Coffee", shape: "took" },
    { id: "gratitude", label: "Gratitude", shape: "noted" }, // non-hidden, reflective
    { id: "mood", label: "Mood", shape: "rated" },
  ];

  it("isReflective is true only for noted", () => {
    expect(isReflective("noted")).toBe(true);
    expect(isReflective("took")).toBe(false);
    expect(isReflective("did")).toBe(false);
    expect(isReflective("happened")).toBe(false);
    expect(isReflective("rated")).toBe(false);
  });

  it("isInputEligible excludes hidden AND non-hidden reflective rows", () => {
    expect(isInputEligible({ id: "a", label: "A", shape: "took" })).toBe(true);
    expect(isInputEligible({ id: "g", label: "G", shape: "noted" })).toBe(false);
    expect(isInputEligible({ id: "h", label: "H", shape: "took", hidden: true })).toBe(false);
  });

  it("SHAPE_ORDER (the 2×2 grid) omits noted but lists the input shapes", () => {
    expect(SHAPE_ORDER).toEqual(["took", "did", "happened", "rated"]);
    expect(SHAPE_ORDER).not.toContain("noted");
  });

  it("thingsOfShape never surfaces a noted row on an input surface", () => {
    // A noted row is non-hidden vocab, but it must not appear when enumerating
    // input things — even if asked for its own shape directly.
    expect(thingsOfShape(vocab, "noted")).toEqual([]);
    expect(thingsOfShape(vocab, "took").map((t) => t.id)).toEqual(["coffee"]);
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
    const tz = "America/Los_Angeles";
    // Pin the reference instant to local noon so the "2 hours earlier" event
    // can never slip across midnight regardless of when the suite runs.
    const today = zonedDateTime(new Date(), 12, 0, tz);
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const earlier = new Date(today.getTime() - 2 * 60 * 60 * 1000);
    const events = [
      ev("coffee", [{ name: "amount", type: "number", value: 8, unit: "oz" }], earlier),
      ev("coffee", [{ name: "amount", type: "number", value: 12, unit: "oz" }], today),
      ev("coffee", [{ name: "amount", type: "number", value: 16, unit: "oz" }], yesterday),
      ev("mood", [{ name: "rating", type: "number", value: 3, unit: "rating" }], today),
    ];
    const out = eventsForThing(events, "coffee", today, tz);
    expect(out.map((e) => e.entries[0].value)).toEqual([12, 8]);
  });

  it("eventsForDay/eventsForThing bucket near-midnight events in the USER tz", () => {
    const tz = "America/Los_Angeles";
    // 23:00 Pacific on June 15 = 06:00 UTC June 16. It must bucket on June 15
    // locally (matching dayIndex + the goal evaluator), not the UTC date.
    const lateNight = zonedDateTime(new Date(Date.UTC(2026, 5, 15, 12)), 23, 0, tz);
    const events = [
      ev("coffee", [{ name: "amount", type: "number", value: 8, unit: "oz" }], lateNight),
    ];
    const onJune15 = zonedDateTime(new Date(Date.UTC(2026, 5, 15, 12)), 9, 0, tz);
    const onJune16 = zonedDateTime(new Date(Date.UTC(2026, 5, 16, 12)), 9, 0, tz);
    expect(eventsForThing(events, "coffee", onJune15, tz)).toHaveLength(1);
    expect(eventsForThing(events, "coffee", onJune16, tz)).toHaveLength(0);
    expect(eventsForDay(events, onJune15, tz)).toHaveLength(1);
    expect(eventsForDay(events, onJune16, tz)).toHaveLength(0);
    // The same key the day index uses agrees.
    expect(dayKey(lateNight, tz)).toBe("2026-06-15");
  });
});
