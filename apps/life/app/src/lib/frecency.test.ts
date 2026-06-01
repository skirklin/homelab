/**
 * P3 — frecency ranking over life_events history.
 *
 * A quick-action is a replayable {entries,labels} payload. Frecency ranks the
 * DISTINCT payloads a user has logged for a trackable by recency-weighted
 * frequency (half-life decay), so the chips surface the doses/counts/oz/
 * categories they actually repeat. Continuous values (every sleep duration is
 * a different number) never cluster into a stable chip — that's intended;
 * pins cover those.
 *
 * Asserts:
 *   - ranking: more-frequent + more-recent payloads rank higher
 *   - recency decay: an old cluster loses to a fresh one of equal raw count
 *   - distinctness/normalization: same value+unit+category collapse to one chip
 *   - discrete clusters vs continuous: repeated discrete doses surface; a
 *     spread of continuous values does not
 *   - dedupe-against-pins: a payload already pinned is not re-surfaced
 *   - cross-trackable aggregation for the global row
 */
import { describe, it, expect } from "vitest";
import type { LifeEvent, QuickPayload, LifeManifestTrackable } from "@homelab/backend";
import { frecentPayloads, globalFrecentActions, payloadKey } from "./frecency";

const NOW = new Date("2026-06-01T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

let counter = 0;
function ev(
  subjectId: string,
  entries: LifeEvent["entries"],
  ts: Date,
  labels?: Record<string, string>,
): LifeEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    log: "log1",
    subjectId,
    timestamp: ts,
    entries,
    labels,
    createdBy: "u1",
    created: ts.toISOString(),
    updated: ts.toISOString(),
  };
}

const num = (name: string, value: number, unit: string) =>
  [{ name, type: "number" as const, value, unit }];

describe("payloadKey normalization", () => {
  it("collapses identical value+unit to the same key regardless of timestamp", () => {
    const a = payloadKey({ entries: num("dose", 5, "mg") });
    const b = payloadKey({ entries: num("dose", 5, "mg") });
    expect(a).toBe(b);
  });

  it("distinguishes different values, units, and categories", () => {
    expect(payloadKey({ entries: num("dose", 5, "mg") })).not.toBe(
      payloadKey({ entries: num("dose", 10, "mg") }),
    );
    expect(payloadKey({ entries: num("v", 8, "oz") })).not.toBe(
      payloadKey({ entries: num("v", 8, "ct") }),
    );
    expect(payloadKey({ entries: num("d", 30, "min"), labels: { category: "run" } })).not.toBe(
      payloadKey({ entries: num("d", 30, "min"), labels: { category: "walk" } }),
    );
  });

  it("is order-insensitive across entries and label keys", () => {
    const a = payloadKey({
      entries: [
        { name: "a", type: "number", value: 1, unit: "ct" },
        { name: "b", type: "number", value: 2, unit: "ct" },
      ],
      labels: { x: "1", y: "2" },
    });
    const b = payloadKey({
      entries: [
        { name: "b", type: "number", value: 2, unit: "ct" },
        { name: "a", type: "number", value: 1, unit: "ct" },
      ],
      labels: { y: "2", x: "1" },
    });
    expect(a).toBe(b);
  });

  it("ignores text entries (free-form, never a quick-action key)", () => {
    const a = payloadKey({
      entries: [
        { name: "dose", type: "number", value: 5, unit: "mg" },
        { name: "notes", type: "text", value: "felt good" },
      ],
    });
    const b = payloadKey({
      entries: [
        { name: "dose", type: "number", value: 5, unit: "mg" },
        { name: "notes", type: "text", value: "different note" },
      ],
    });
    expect(a).toBe(b);
  });
});

describe("frecentPayloads ranking", () => {
  const edibles: LifeManifestTrackable = {
    id: "edibles",
    label: "Edibles",
    fields: [{ key: "dose", type: "number", unit: "mg" }],
  };

  it("ranks a more-frequent discrete value above a rarer one", () => {
    const events = [
      ev("edibles", num("dose", 5, "mg"), day(1)),
      ev("edibles", num("dose", 5, "mg"), day(2)),
      ev("edibles", num("dose", 5, "mg"), day(3)),
      ev("edibles", num("dose", 10, "mg"), day(4)),
    ];
    const out = frecentPayloads(events, edibles, { now: NOW, limit: 5 });
    expect(out[0].entries).toEqual(num("dose", 5, "mg"));
    expect(out[1].entries).toEqual(num("dose", 10, "mg"));
  });

  it("recency decay: a fresh cluster outranks an older one of equal raw count", () => {
    const events = [
      // value 7: two hits, both old (~60d)
      ev("edibles", num("dose", 7, "mg"), day(60)),
      ev("edibles", num("dose", 7, "mg"), day(61)),
      // value 3: two hits, both recent
      ev("edibles", num("dose", 3, "mg"), day(0)),
      ev("edibles", num("dose", 3, "mg"), day(1)),
    ];
    const out = frecentPayloads(events, edibles, { now: NOW, limit: 5, halfLifeDays: 14 });
    expect(out[0].entries).toEqual(num("dose", 3, "mg"));
  });

  it("continuous values do NOT cluster into a dominant chip; discrete ones do", () => {
    // sleep: every duration distinct (continuous) → each scores 1, no cluster.
    // A repeated 480 still wins because it actually clusters.
    const sleep: LifeManifestTrackable = {
      id: "sleep",
      label: "Sleep",
      fields: [{ key: "duration", type: "number", unit: "min" }],
    };
    const events = [
      ev("sleep", num("duration", 437, "min"), day(1)),
      ev("sleep", num("duration", 462, "min"), day(2)),
      ev("sleep", num("duration", 491, "min"), day(3)),
      ev("sleep", num("duration", 480, "min"), day(4)),
      ev("sleep", num("duration", 480, "min"), day(5)),
      ev("sleep", num("duration", 480, "min"), day(6)),
    ];
    const out = frecentPayloads(events, sleep, { now: NOW, limit: 1 });
    // The clustered 480 wins the single slot; the one-off continuous values
    // each score ~1 and lose.
    expect(out).toHaveLength(1);
    expect(out[0].entries).toEqual(num("duration", 480, "min"));
  });

  it("respects the limit", () => {
    const events = [
      ev("edibles", num("dose", 1, "mg"), day(1)),
      ev("edibles", num("dose", 2, "mg"), day(2)),
      ev("edibles", num("dose", 3, "mg"), day(3)),
      ev("edibles", num("dose", 4, "mg"), day(4)),
    ];
    const out = frecentPayloads(events, edibles, { now: NOW, limit: 2 });
    expect(out).toHaveLength(2);
  });

  it("dedupes against pinned payloads", () => {
    const pins: QuickPayload[] = [{ label: "5mg", entries: num("dose", 5, "mg") }];
    const events = [
      ev("edibles", num("dose", 5, "mg"), day(1)),
      ev("edibles", num("dose", 5, "mg"), day(2)),
      ev("edibles", num("dose", 10, "mg"), day(3)),
    ];
    const out = frecentPayloads(events, edibles, { now: NOW, limit: 5, exclude: pins });
    // 5mg is pinned → excluded from frecency even though it's the most frequent.
    expect(out.map((p) => p.entries)).toEqual([num("dose", 10, "mg")]);
  });

  it("ignores events for other trackables", () => {
    const events = [
      ev("edibles", num("dose", 5, "mg"), day(1)),
      ev("coffee", num("volume", 8, "oz"), day(1)),
    ];
    const out = frecentPayloads(events, edibles, { now: NOW, limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].entries).toEqual(num("dose", 5, "mg"));
  });

  it("carries category labels into the surfaced payload", () => {
    const exercise: LifeManifestTrackable = {
      id: "exercise",
      label: "Exercise",
      fields: [
        { key: "duration", type: "number", unit: "min" },
        { key: "category", type: "category", options: ["walk", "run"] },
      ],
    };
    const events = [
      ev("exercise", num("duration", 30, "min"), day(1), { category: "run" }),
      ev("exercise", num("duration", 30, "min"), day(2), { category: "run" }),
      ev("exercise", num("duration", 20, "min"), day(3), { category: "walk" }),
    ];
    const out = frecentPayloads(events, exercise, { now: NOW, limit: 5 });
    expect(out[0].labels).toEqual({ category: "run" });
    expect(out[0].entries).toEqual(num("duration", 30, "min"));
  });
});

describe("globalFrecentActions (cross-trackable)", () => {
  const edibles: LifeManifestTrackable = {
    id: "edibles",
    label: "Edibles",
    fields: [{ key: "dose", type: "number", unit: "mg" }],
  };
  const coffee: LifeManifestTrackable = {
    id: "coffee",
    label: "Coffee",
    fields: [{ key: "volume", type: "number", unit: "oz" }],
  };
  const hidden: LifeManifestTrackable = {
    id: "secret",
    label: "Secret",
    hidden: true,
    fields: [{ key: "count", type: "number", unit: "ct" }],
  };

  it("returns top actions tagged with their trackable, across trackables", () => {
    const events = [
      ev("edibles", num("dose", 5, "mg"), day(1)),
      ev("edibles", num("dose", 5, "mg"), day(2)),
      ev("coffee", num("volume", 8, "oz"), day(3)),
    ];
    const out = globalFrecentActions(events, [edibles, coffee], { now: NOW, limit: 5 });
    const ids = out.map((a) => a.trackable.id);
    expect(ids).toContain("edibles");
    expect(ids).toContain("coffee");
    // edibles 5mg (logged twice) outranks the single coffee.
    expect(out[0].trackable.id).toBe("edibles");
  });

  it("excludes hidden trackables", () => {
    const events = [
      ev("secret", num("count", 1, "ct"), day(1)),
      ev("secret", num("count", 1, "ct"), day(2)),
      ev("coffee", num("volume", 8, "oz"), day(3)),
    ];
    const out = globalFrecentActions(events, [hidden, coffee], { now: NOW, limit: 5 });
    expect(out.every((a) => a.trackable.id !== "secret")).toBe(true);
  });

  it("surfaces pins first, then frecency, deduped", () => {
    const withPin: LifeManifestTrackable = {
      ...edibles,
      pinned: [{ label: "5mg", entries: num("dose", 5, "mg") }],
    };
    const events = [
      ev("edibles", num("dose", 5, "mg"), day(1)),
      ev("edibles", num("dose", 10, "mg"), day(2)),
      ev("edibles", num("dose", 10, "mg"), day(3)),
    ];
    const out = globalFrecentActions(events, [withPin], { now: NOW, limit: 5 });
    // Pin (5mg) comes first and is flagged; 10mg follows from frecency, not
    // duplicated.
    expect(out[0].payload.entries).toEqual(num("dose", 5, "mg"));
    expect(out[0].pinned).toBe(true);
    expect(out.some((a) => !a.pinned && payloadKey(a.payload) === payloadKey({ entries: num("dose", 10, "mg") }))).toBe(true);
    // 5mg appears once (as the pin), not again from frecency.
    expect(out.filter((a) => payloadKey(a.payload) === payloadKey({ entries: num("dose", 5, "mg") }))).toHaveLength(1);
  });
});
