/**
 * Frecency ranking over life_events history — shape-model edition.
 *
 * A quick-action is a replayable (subjectId, payload) pair. Asserts:
 *   - payloadKey INCLUDES the subjectId (same values on different things are
 *     distinct actions), excludes text entries, and is NAME-AGNOSTIC over
 *     entry names (dose=5:mg ≡ amount=5:mg, mirroring the readers)
 *   - eventToPayload strips text entries (excluded from replay) + provenance
 *     labels
 *   - ranking: more-frequent + more-recent payloads rank higher; decay
 *   - dedupe-against-pins
 *   - favorites row (pinnedActions): ONLY explicit pins, vocab order, deduped,
 *     hidden + reflective (noted) vocab never surface, NO frecency fill
 */
import { describe, it, expect } from "vitest";
import type { LifeEvent, QuickPayload, LifeManifestTrackable } from "@homelab/backend";
import { frecentPayloads, pinnedActions, payloadKey, eventToPayload } from "./frecency";

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

const edibles: LifeManifestTrackable = {
  id: "edibles",
  label: "Edibles",
  shape: "took",
  defaultUnit: "mg",
};
const coffee: LifeManifestTrackable = {
  id: "coffee",
  label: "Coffee",
  shape: "took",
  defaultUnit: "oz",
};

describe("payloadKey", () => {
  it("collapses identical subject+value+unit to the same key", () => {
    const a = payloadKey("edibles", { entries: num("dose", 5, "mg") });
    const b = payloadKey("edibles", { entries: num("dose", 5, "mg") });
    expect(a).toBe(b);
  });

  it("INCLUDES the subjectId — same payload on different things is distinct", () => {
    const a = payloadKey("vyvanse", { entries: num("amount", 30, "mg") });
    const b = payloadKey("ibuprofin", { entries: num("amount", 30, "mg") });
    expect(a).not.toBe(b);
  });

  it("is NAME-AGNOSTIC — a legacy entry name and the canonical one with the same value:unit collapse", () => {
    // Pre-migration history/pins say dose=5:mg; new shape-model events say
    // amount=5:mg. The readers treat them as the same measurement, so the
    // quick-action identity must too.
    const legacy = payloadKey("edibles", { entries: num("dose", 5, "mg") });
    const canonical = payloadKey("edibles", { entries: num("amount", 5, "mg") });
    expect(legacy).toBe(canonical);
  });

  it("distinguishes different values, units, and labels", () => {
    expect(payloadKey("e", { entries: num("dose", 5, "mg") })).not.toBe(
      payloadKey("e", { entries: num("dose", 10, "mg") }),
    );
    expect(payloadKey("e", { entries: num("v", 8, "oz") })).not.toBe(
      payloadKey("e", { entries: num("v", 8, "ct") }),
    );
    expect(payloadKey("e", { entries: num("d", 30, "min"), labels: { category: "run" } })).not.toBe(
      payloadKey("e", { entries: num("d", 30, "min"), labels: { category: "walk" } }),
    );
  });

  it("is order-insensitive across entries and label keys", () => {
    const a = payloadKey("x", {
      entries: [
        { name: "a", type: "number", value: 1, unit: "ct" },
        { name: "b", type: "number", value: 2, unit: "ct" },
      ],
      labels: { x: "1", y: "2" },
    });
    const b = payloadKey("x", {
      entries: [
        { name: "b", type: "number", value: 2, unit: "ct" },
        { name: "a", type: "number", value: 1, unit: "ct" },
      ],
      labels: { y: "2", x: "1" },
    });
    expect(a).toBe(b);
  });

  it("ignores text entries (free-form, never part of a quick-action key)", () => {
    const a = payloadKey("sleep", {
      entries: [
        { name: "duration", type: "number", value: 480, unit: "min" },
        { name: "notes", type: "text", value: "slept great" },
      ],
    });
    const b = payloadKey("sleep", {
      entries: [
        { name: "duration", type: "number", value: 480, unit: "min" },
        { name: "notes", type: "text", value: "different note" },
      ],
    });
    expect(a).toBe(b);
  });
});

describe("eventToPayload", () => {
  it("drops text entries from replay and provenance labels", () => {
    const e = ev(
      "sleep",
      [
        { name: "duration", type: "number", value: 480, unit: "min" },
        { name: "notes", type: "text", value: "private prose" },
      ],
      day(1),
      { source: "manual", tz: "America/Los_Angeles", category: "nap" },
    );
    const p = eventToPayload(e);
    expect(p.entries).toEqual(num("duration", 480, "min"));
    expect(p.labels).toEqual({ category: "nap" });
  });

  it("preserves rating scale on number entries", () => {
    const e = ev("mood", [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }], day(0));
    expect(eventToPayload(e).entries).toEqual([
      { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
    ]);
  });
});

describe("frecentPayloads ranking", () => {
  it("ranks a more-frequent discrete value above a rarer one", () => {
    const events = [
      ev("edibles", num("dose", 5, "mg"), day(1)),
      ev("edibles", num("dose", 5, "mg"), day(2)),
      ev("edibles", num("dose", 5, "mg"), day(3)),
      ev("edibles", num("dose", 10, "mg"), day(4)),
    ];
    const out = frecentPayloads(events, "edibles", { now: NOW, limit: 5 });
    expect(out[0].entries).toEqual(num("dose", 5, "mg"));
    expect(out[1].entries).toEqual(num("dose", 10, "mg"));
  });

  it("recency decay: a fresh cluster outranks an older one of equal raw count", () => {
    const events = [
      ev("edibles", num("dose", 7, "mg"), day(60)),
      ev("edibles", num("dose", 7, "mg"), day(61)),
      ev("edibles", num("dose", 3, "mg"), day(0)),
      ev("edibles", num("dose", 3, "mg"), day(1)),
    ];
    const out = frecentPayloads(events, "edibles", { now: NOW, limit: 5, halfLifeDays: 14 });
    expect(out[0].entries).toEqual(num("dose", 3, "mg"));
  });

  it("continuous values do NOT cluster; repeated discrete ones do", () => {
    const events = [
      ev("sleep", num("duration", 437, "min"), day(1)),
      ev("sleep", num("duration", 462, "min"), day(2)),
      ev("sleep", num("duration", 491, "min"), day(3)),
      ev("sleep", num("duration", 480, "min"), day(4)),
      ev("sleep", num("duration", 480, "min"), day(5)),
      ev("sleep", num("duration", 480, "min"), day(6)),
    ];
    const out = frecentPayloads(events, "sleep", { now: NOW, limit: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].entries).toEqual(num("duration", 480, "min"));
  });

  it("respects the limit and ignores other subjects", () => {
    const events = [
      ev("edibles", num("dose", 1, "mg"), day(1)),
      ev("edibles", num("dose", 2, "mg"), day(2)),
      ev("edibles", num("dose", 3, "mg"), day(3)),
      ev("coffee", num("volume", 8, "oz"), day(1)),
    ];
    const out = frecentPayloads(events, "edibles", { now: NOW, limit: 2 });
    expect(out).toHaveLength(2);
  });

  it("dedupes against pinned payloads", () => {
    const pins: QuickPayload[] = [{ label: "5mg", entries: num("dose", 5, "mg") }];
    const events = [
      ev("edibles", num("dose", 5, "mg"), day(1)),
      ev("edibles", num("dose", 5, "mg"), day(2)),
      ev("edibles", num("dose", 10, "mg"), day(3)),
    ];
    const out = frecentPayloads(events, "edibles", { now: NOW, limit: 5, exclude: pins });
    expect(out.map((p) => p.entries)).toEqual([num("dose", 10, "mg")]);
  });

  it("skips events with no replayable measurement (text-only entries)", () => {
    const events = [
      ev("journal", [{ name: "notes", type: "text", value: "prose" }], day(1)),
    ];
    expect(frecentPayloads(events, "journal", { now: NOW })).toEqual([]);
  });
});

describe("pinnedActions (favorites row)", () => {
  it("returns ONLY pinned actions, in vocab order, tagged pinned", () => {
    const withPin: LifeManifestTrackable = {
      ...edibles,
      pinned: [{ label: "5mg", entries: num("dose", 5, "mg") }],
    };
    const coffeePinned: LifeManifestTrackable = {
      ...coffee,
      pinned: [{ label: "8oz", entries: num("volume", 8, "oz") }],
    };
    const out = pinnedActions([withPin, coffeePinned]);
    expect(out.map((a) => a.trackable.id)).toEqual(["edibles", "coffee"]);
    expect(out.every((a) => a.pinned)).toBe(true);
  });

  it("returns nothing for a trackable with NO pins (no frecency fill)", () => {
    // edibles has rich history but no pins → it must NOT surface on favorites.
    const out = pinnedActions([edibles, coffee]);
    expect(out).toEqual([]);
  });

  it("excludes hidden trackables even when pinned", () => {
    const hidden: LifeManifestTrackable = {
      id: "secret",
      label: "Secret",
      shape: "happened",
      hidden: true,
      pinned: [{ label: "tap", entries: num("count", 1, "ct") }],
    };
    const out = pinnedActions([hidden]);
    expect(out).toEqual([]);
  });

  it("excludes NON-HIDDEN reflective (noted) trackables, incl. their pins", () => {
    const gratitude: LifeManifestTrackable = {
      id: "gratitude",
      label: "Gratitude",
      shape: "noted",
      pinned: [{ label: "x", entries: num("count", 1, "ct") }],
    };
    const out = pinnedActions([gratitude]);
    expect(out).toEqual([]);
  });

  it("dedupes identical pins within a trackable (vocab-name-agnostic key)", () => {
    const dup: LifeManifestTrackable = {
      ...edibles,
      pinned: [
        { label: "5mg", entries: num("dose", 5, "mg") },
        // same value:unit, legacy vs canonical entry name → same key, deduped
        { label: "5mg", entries: num("amount", 5, "mg") },
      ],
    };
    const out = pinnedActions([dup]);
    expect(out).toHaveLength(1);
  });
});
