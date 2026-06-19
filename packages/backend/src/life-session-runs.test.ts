/**
 * Tests for the shared session-run normalizer (Phase B3.3).
 *
 * Post-fanout the on-disk shape is per-item only: N `life_events` rows per run,
 * each under its own vocab `subject_id`, correlated by `labels.view` +
 * `labels.view_run`. The normalizer groups those children into one run; events
 * with no run signal are ignored. Children whose `view_run` differs only in
 * string form (ISO "T" vs PB space) still group into the same run.
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

/** Reduce a run to a comparable {view, vocabId→[entries]}. */
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

describe("normalizeSessionRuns", () => {
  it("groups labelled children by (view, view_run) into one run", () => {
    const runs = normalizeSessionRuns([
      ev("c1", "gratitude", [{ name: "note", type: "text", value: "coffee" }], TS, { view: "morning", view_run: TS }),
      ev("c2", "daily_intention", [{ name: "note", type: "text", value: "ship it" }], TS, { view: "morning", view_run: TS }),
      ev("c3", "energy", [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }], TS, { view: "morning", view_run: TS }),
    ]);
    expect(runs).toHaveLength(1);
    expect(logical(runs[0])).toEqual({
      view: "morning",
      values: {
        gratitude: [[{ name: "note", type: "text", value: "coffee" }]],
        daily_intention: [[{ name: "note", type: "text", value: "ship it" }]],
        energy: [[{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }]],
      },
    });
  });

  it("keeps evening + weekly runs distinct, mood routed into the live `mood` series", () => {
    const runs = normalizeSessionRuns([
      ev("c1", "daily_win", [{ name: "note", type: "text", value: "shipped" }], TS, { view: "evening", view_run: TS }),
      ev("c2", "mood", [{ name: "rating", type: "number", value: 5, unit: "rating", scale: 5 }], TS, { view: "evening", view_run: TS }),
      ev("c3", "weekly_intention", [{ name: "note", type: "text", value: "rest" }], TS, { view: "weekly", view_run: TS }),
      ev("c4", "mood", [{ name: "rating", type: "number", value: 3, unit: "rating", scale: 5 }], TS, { view: "weekly", view_run: TS }),
    ]);
    const byView = Object.fromEntries(runs.map((r) => [r.view, logical(r)]));
    expect(byView.evening.values.daily_win).toEqual([[{ name: "note", type: "text", value: "shipped" }]]);
    expect(byView.evening.values.mood).toEqual([[{ name: "rating", type: "number", value: 5, unit: "rating", scale: 5 }]]);
    expect(byView.weekly.values.weekly_intention).toEqual([[{ name: "note", type: "text", value: "rest" }]]);
    expect(byView.weekly.values.mood).toEqual([[{ name: "rating", type: "number", value: 3, unit: "rating", scale: 5 }]]);
    expect(byView.weekly.values.daily_intention).toBeUndefined();
  });

  it("a live `mood` sample (no view_run) is NOT treated as a run", () => {
    const runs = normalizeSessionRuns([
      ev("s1", "mood", [{ name: "rating", type: "number", value: 3, unit: "rating", scale: 5 }], TS, { source: "sample" }),
    ]);
    expect(runs).toHaveLength(0);
  });

  it("runs with different view_run instants are NOT merged", () => {
    const other = "2026-06-17T15:00:00.000Z";
    const runs = normalizeSessionRuns([
      ev("c1", "gratitude", [{ name: "note", type: "text", value: "x" }], other, { view: "morning", view_run: other }),
      ev("c2", "gratitude", [{ name: "note", type: "text", value: "y" }], TS, { view: "morning", view_run: TS }),
    ]);
    expect(runs).toHaveLength(2);
  });

  it("groups children whose view_run differ only in string form (ISO T vs PB space)", () => {
    // The fanout migration set view_run = source.timestamp, which in PB is
    // "YYYY-MM-DD HH:MM:SS.mmmZ" (a space, not a T). A child written with the
    // ISO "T" form for the same instant must group with it.
    const pbForm = "2026-06-18 15:00:00.000Z"; // same instant as TS, space form.
    const runs = normalizeSessionRuns([
      ev("c1", "gratitude", [{ name: "note", type: "text", value: "coffee" }], TS, { view: "morning", view_run: TS }),
      ev("c2", "daily_intention", [{ name: "note", type: "text", value: "ship it" }], TS, {
        view: "morning",
        view_run: pbForm,
      }),
    ]);
    expect(runs).toHaveLength(1);
    expect(Object.keys(runs[0].values).sort()).toEqual(["daily_intention", "gratitude"]);
  });
});
