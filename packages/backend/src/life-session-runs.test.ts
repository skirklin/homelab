/**
 * Tests for the shared session-run normalizer (Phase B3.2).
 *
 * The crux: a FAT session event and its equivalent PER-ITEM events normalize to
 * the SAME logical run (same view, same vocab-id → value mapping), and when BOTH
 * are present (the transient `--apply` window) the fat one is DROPPED so the run
 * is not double-counted.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeSessionRuns,
  type NormalizerEvent,
  type SessionRun,
} from "./life-session-runs";
import type { LifeEntry } from "./types/life";

function ev(
  id: string,
  subjectId: string,
  entries: LifeEntry[],
  iso: string,
  labels?: Record<string, string>,
): NormalizerEvent {
  return { id, subjectId, timestamp: new Date(iso), entries, labels: labels ?? null };
}

/** Reduce a run to a comparable {view, vocabId→[entries]} so fat vs per-item
 *  can be asserted equal regardless of source/id/timestamp. */
function logical(run: SessionRun): {
  view: string;
  values: Record<string, LifeEntry[][]>;
} {
  const values: Record<string, LifeEntry[][]> = {};
  for (const [vocabId, items] of Object.entries(run.values)) {
    values[vocabId] = items.map((i) => i.entries);
  }
  return { view: run.view, values };
}

const TS = "2026-06-18T15:00:00.000Z";

describe("normalizeSessionRuns — fat-only", () => {
  it("maps a fat morning_session to per-vocab values", () => {
    const runs = normalizeSessionRuns([
      ev("m1", "morning_session", [
        { name: "gratitude", type: "text", value: "coffee" },
        { name: "intention", type: "text", value: "ship it" },
        { name: "energy", type: "number", value: 4, unit: "rating", scale: 5 },
      ], TS),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].source).toBe("fat");
    expect(logical(runs[0])).toEqual({
      view: "morning",
      values: {
        gratitude: [[{ name: "note", type: "text", value: "coffee" }]],
        daily_intention: [[{ name: "note", type: "text", value: "ship it" }]],
        energy: [[{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }]],
      },
    });
  });

  it("routes evening mood + weekly mood_rating into the live `mood` series", () => {
    const runs = normalizeSessionRuns([
      ev("e1", "evening_session", [
        { name: "win", type: "text", value: "shipped" },
        { name: "mood", type: "number", value: 5, unit: "rating", scale: 5 },
      ], TS),
      ev("w1", "weekly_review_session", [
        { name: "intention", type: "text", value: "rest" },
        { name: "mood_rating", type: "number", value: 3, unit: "rating", scale: 5 },
      ], TS),
    ]);
    const byView = Object.fromEntries(runs.map((r) => [r.view, logical(r)]));
    expect(byView.evening.values.daily_win).toEqual([[{ name: "note", type: "text", value: "shipped" }]]);
    expect(byView.evening.values.mood).toEqual([[{ name: "rating", type: "number", value: 5, unit: "rating", scale: 5 }]]);
    // weekly.intention -> weekly_intention (NOT daily_intention), mood_rating -> mood
    expect(byView.weekly.values.weekly_intention).toEqual([[{ name: "note", type: "text", value: "rest" }]]);
    expect(byView.weekly.values.mood).toEqual([[{ name: "rating", type: "number", value: 3, unit: "rating", scale: 5 }]]);
    expect(byView.weekly.values.daily_intention).toBeUndefined();
  });

  it("skips unmapped legacy entry names without crashing", () => {
    const runs = normalizeSessionRuns([
      ev("m1", "morning_session", [
        { name: "gratitude", type: "text", value: "coffee" },
        { name: "mystery_legacy", type: "text", value: "???" },
      ], TS),
    ]);
    expect(Object.keys(runs[0].values)).toEqual(["gratitude"]);
  });
});

describe("normalizeSessionRuns — per-item-only", () => {
  it("groups labelled children by (view, view_run) into one run", () => {
    const runs = normalizeSessionRuns([
      ev("c1", "gratitude", [{ name: "note", type: "text", value: "coffee" }], TS, { view: "morning", view_run: TS }),
      ev("c2", "daily_intention", [{ name: "note", type: "text", value: "ship it" }], TS, { view: "morning", view_run: TS }),
      ev("c3", "energy", [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }], TS, { view: "morning", view_run: TS }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].source).toBe("per-item");
    expect(logical(runs[0])).toEqual({
      view: "morning",
      values: {
        gratitude: [[{ name: "note", type: "text", value: "coffee" }]],
        daily_intention: [[{ name: "note", type: "text", value: "ship it" }]],
        energy: [[{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }]],
      },
    });
  });

  it("a live `mood` sample (no view_run) is NOT treated as a run", () => {
    const runs = normalizeSessionRuns([
      ev("s1", "mood", [{ name: "rating", type: "number", value: 3, unit: "rating", scale: 5 }], TS, { source: "sample" }),
    ]);
    expect(runs).toHaveLength(0);
  });
});

describe("normalizeSessionRuns — fat == per-item parity", () => {
  it("a fat run and its per-item equivalent yield the SAME logical run", () => {
    const fatRuns = normalizeSessionRuns([
      ev("m1", "morning_session", [
        { name: "gratitude", type: "text", value: "coffee" },
        { name: "intention", type: "text", value: "ship it" },
        { name: "energy", type: "number", value: 4, unit: "rating", scale: 5 },
      ], TS),
    ]);
    const perItemRuns = normalizeSessionRuns([
      ev("c1", "gratitude", [{ name: "note", type: "text", value: "coffee" }], TS, { view: "morning", view_run: TS }),
      ev("c2", "daily_intention", [{ name: "note", type: "text", value: "ship it" }], TS, { view: "morning", view_run: TS }),
      ev("c3", "energy", [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }], TS, { view: "morning", view_run: TS }),
    ]);
    expect(logical(perItemRuns[0])).toEqual(logical(fatRuns[0]));
  });
});

describe("normalizeSessionRuns — both-present dedup (transient --apply window)", () => {
  it("drops the fat run when a per-item run shares (view, view_run==fat.timestamp.toISOString())", () => {
    // The migration writes children with view_run = source.timestamp ISO. With
    // BOTH on disk mid-migration, only the per-item run should survive.
    const runs = normalizeSessionRuns([
      // fat (source not yet deleted)
      ev("m1", "morning_session", [
        { name: "gratitude", type: "text", value: "coffee" },
        { name: "intention", type: "text", value: "ship it" },
      ], TS),
      // per-item (children already created)
      ev("c1", "gratitude", [{ name: "note", type: "text", value: "coffee" }], TS, { view: "morning", view_run: TS }),
      ev("c2", "daily_intention", [{ name: "note", type: "text", value: "ship it" }], TS, { view: "morning", view_run: TS }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].source).toBe("per-item");
  });

  it("a fat run with a DIFFERENT timestamp is NOT deduped against a per-item run", () => {
    const other = "2026-06-17T15:00:00.000Z";
    const runs = normalizeSessionRuns([
      ev("m1", "morning_session", [{ name: "gratitude", type: "text", value: "x" }], other),
      ev("c1", "gratitude", [{ name: "note", type: "text", value: "y" }], TS, { view: "morning", view_run: TS }),
    ]);
    expect(runs).toHaveLength(2);
  });

  it("dedups even when the child's view_run is the PB SPACE-separated timestamp form", () => {
    // The migration writes view_run = source.timestamp, which in PB is
    // "YYYY-MM-DD HH:MM:SS.mmmZ" (a space, not a T). The fat side canonicalizes
    // its toISOString() form to the same instant, so they still dedup.
    const pbForm = "2026-06-18 15:00:00.000Z"; // same instant as TS, space form.
    const runs = normalizeSessionRuns([
      ev("m1", "morning_session", [{ name: "gratitude", type: "text", value: "coffee" }], TS),
      ev("c1", "gratitude", [{ name: "note", type: "text", value: "coffee" }], TS, {
        view: "morning",
        view_run: pbForm,
      }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].source).toBe("per-item");
  });
});
