/**
 * Tests for the travel reducer's `activitiesLoaded` flag. Trips and activities
 * ride independent mirror subscriptions that resolve out of order, so the UI
 * gates activity-dependent rendering on `activitiesLoaded` rather than on
 * `loading` (which clears on trips arrival). Two guarantees matter:
 *   1. SET_ACTIVITIES with an EMPTY array still flips activitiesLoaded → true,
 *      so a trip with zero activities doesn't spin forever.
 *   2. CLEAR_DATA resets it → false, so a log switch re-gates until the new
 *      log's activities replay.
 */
import { describe, it, expect } from "vitest";
import { reducer, initialState } from "./travel-context";

describe("travel reducer — activitiesLoaded", () => {
  it("starts false", () => {
    expect(initialState.activitiesLoaded).toBe(false);
  });

  it("SET_ACTIVITIES with an empty array still sets activitiesLoaded = true", () => {
    const next = reducer(initialState, { type: "SET_ACTIVITIES", activities: [] });
    expect(next.activitiesLoaded).toBe(true);
    expect(next.activities.size).toBe(0);
  });

  it("CLEAR_DATA resets activitiesLoaded to false", () => {
    const loaded = reducer(initialState, { type: "SET_ACTIVITIES", activities: [] });
    expect(loaded.activitiesLoaded).toBe(true);

    const cleared = reducer(loaded, { type: "CLEAR_DATA" });
    expect(cleared.activitiesLoaded).toBe(false);
    expect(cleared.activities.size).toBe(0);
  });
});
