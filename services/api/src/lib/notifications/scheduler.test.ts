/**
 * runObserverWeekly — coach_enabled gating.
 *
 * The weekly observer cron iterates every life_logs owner and calls
 * runObserverGeneration (an Anthropic call) for those with activity in the
 * window. Owners who turned Coach off (coach_enabled === false) must be skipped
 * so no tokens are spent. Default-true semantics: undefined/true still generate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the vi.mock factories (which are hoisted to the top of the file)
// can close over them without a TDZ error.
const h = vi.hoisted(() => {
  const lifeLogsRows: Array<Record<string, unknown>> = [];
  const runObserverGeneration = vi.fn().mockResolvedValue({});
  const pb = {
    filter: (s: string) => s,
    collection: () => ({
      // life_logs.getFullList → the owner roster + their coach_enabled flag.
      getFullList: () => Promise.resolve(lifeLogsRows),
      // life_events.getList → "has activity in window" gate; always say yes so
      // the only thing that can skip an owner in these tests is coach_enabled.
      getList: () => Promise.resolve({ totalItems: 1 }),
    }),
  };
  return { lifeLogsRows, runObserverGeneration, pb };
});

vi.mock("../pb", () => ({ getAdminPb: () => Promise.resolve(h.pb) }));
vi.mock("../observer/generate", () => ({ runObserverGeneration: h.runObserverGeneration }));

import { runObserverWeekly } from "./scheduler";

const { runObserverGeneration, lifeLogsRows } = h;

function setLogs(rows: Array<Record<string, unknown>>) {
  lifeLogsRows.length = 0;
  lifeLogsRows.push(...rows);
}

describe("runObserverWeekly — coach_enabled gating", () => {
  beforeEach(() => {
    runObserverGeneration.mockClear();
  });

  it("generates for owners with coach_enabled true / undefined (default on)", async () => {
    setLogs([
      { owner: "u-on", coach_enabled: true },
      { owner: "u-legacy" }, // undefined → enabled
    ]);
    await runObserverWeekly();
    const owners = runObserverGeneration.mock.calls.map((c) => c[0].ownerId).sort();
    expect(owners).toEqual(["u-legacy", "u-on"]);
  });

  it("skips an owner whose log has coach_enabled === false", async () => {
    setLogs([
      { owner: "u-off", coach_enabled: false },
      { owner: "u-on", coach_enabled: true },
    ]);
    await runObserverWeekly();
    const owners = runObserverGeneration.mock.calls.map((c) => c[0].ownerId);
    expect(owners).toEqual(["u-on"]);
    expect(owners).not.toContain("u-off");
  });

  it("still generates if ANY of an owner's logs has coach enabled", async () => {
    setLogs([
      { owner: "u-multi", coach_enabled: false },
      { owner: "u-multi", coach_enabled: true },
    ]);
    await runObserverWeekly();
    const owners = runObserverGeneration.mock.calls.map((c) => c[0].ownerId);
    expect(owners).toEqual(["u-multi"]);
  });
});
