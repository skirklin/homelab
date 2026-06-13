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
 *   - global row: ALL pins first (vocab order, never trimmed), frecency fills
 *     to the limit, hidden trackables never surface
 */
import { describe, it, expect } from "vitest";
import type { LifeEvent, QuickPayload, LifeManifestTrackable } from "@homelab/backend";
import { frecentPayloads, globalFrecentActions, payloadKey, eventToPayload } from "./frecency";

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

describe("globalFrecentActions (cross-thing)", () => {
  const hidden: LifeManifestTrackable = {
    id: "secret",
    label: "Secret",
    shape: "happened",
    hidden: true,
  };

  it("returns top actions tagged with their trackable, across things", () => {
    const events = [
      ev("edibles", num("dose", 5, "mg"), day(1)),
      ev("edibles", num("dose", 5, "mg"), day(2)),
      ev("coffee", num("volume", 8, "oz"), day(3)),
    ];
    const out = globalFrecentActions(events, [edibles, coffee], { now: NOW, limit: 5 });
    const ids = out.map((a) => a.trackable.id);
    expect(ids).toContain("edibles");
    expect(ids).toContain("coffee");
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

  it("surfaces pins first (vocab order), then frecency, deduped", () => {
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
    expect(out[0].payload.entries).toEqual(num("dose", 5, "mg"));
    expect(out[0].pinned).toBe(true);
    const key10 = payloadKey("edibles", { entries: num("dose", 10, "mg") });
    expect(out.some((a) => !a.pinned && payloadKey(a.trackable.id, a.payload) === key10)).toBe(true);
    const key5 = payloadKey("edibles", { entries: num("dose", 5, "mg") });
    expect(out.filter((a) => payloadKey(a.trackable.id, a.payload) === key5)).toHaveLength(1);
  });

  it("dedups an old-name pin against its canonical-name frecency twin — ONE chip, the pin wins", () => {
    // Pin predates the shape migration (entry name "dose"); fresh events use
    // the canonical name "amount". Same value:unit → same quick-action: the
    // pin renders, the frecency twin is suppressed.
    const withOldNamePin: LifeManifestTrackable = {
      ...edibles,
      pinned: [{ label: "5mg", entries: num("dose", 5, "mg") }],
    };
    const events = [
      ev("edibles", num("amount", 5, "mg"), day(1)),
      ev("edibles", num("amount", 5, "mg"), day(2)),
      ev("edibles", num("amount", 5, "mg"), day(3)),
    ];
    const out = globalFrecentActions(events, [withOldNamePin], { now: NOW, limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].pinned).toBe(true);
    expect(out[0].payload.entries).toEqual(num("dose", 5, "mg"));
  });

  it("NEVER trims pins, even past the limit; frecency only fills leftover slots", () => {
    const pinned = (id: string, label: string, n: number): LifeManifestTrackable => ({
      id,
      label,
      shape: "took",
      pinned: Array.from({ length: n }, (_, i) => ({
        label: `${i}`,
        entries: num("amount", i + 1, "mg"),
      })),
    });
    const a = pinned("a", "A", 2);
    const b = pinned("b", "B", 2);
    const events = [
      ev("coffee", num("volume", 8, "oz"), day(0)),
      ev("coffee", num("volume", 8, "oz"), day(1)),
    ];
    // limit 3 < 4 pins: all 4 pins survive, frecency adds nothing.
    const capped = globalFrecentActions(events, [a, b, coffee], { now: NOW, limit: 3 });
    expect(capped).toHaveLength(4);
    expect(capped.every((x) => x.pinned)).toBe(true);
    // Pins come out in vocab order: a's pins then b's.
    expect(capped.map((x) => x.trackable.id)).toEqual(["a", "a", "b", "b"]);
    // limit 5: 4 pins + 1 frecency fill.
    const filled = globalFrecentActions(events, [a, b, coffee], { now: NOW, limit: 5 });
    expect(filled).toHaveLength(5);
    expect(filled[4]).toMatchObject({ pinned: false });
    expect(filled[4].trackable.id).toBe("coffee");
  });
});
