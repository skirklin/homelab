import { describe, it, expect } from "vitest";
import {
  addTrackable,
  updateTrackable,
  removeTrackable,
  reorderTrackables,
  reorderById,
  patchOptionalString,
  setPins,
  slugifyTrackableId,
  ManifestError,
  emptyManifest,
} from "./life-manifest-ops";
import { addGoal, updateGoal, removeGoal, reorderGoals } from "./life-goal-ops";
import type { LifeManifest } from "./types/life";

function base(): LifeManifest {
  return {
    trackables: [
      { id: "coffee", label: "Coffee", shape: "took", defaultUnit: "oz", defaultAmount: 8 },
      { id: "mood", label: "Mood", shape: "rated" },
      { id: "run", label: "Run", shape: "did", group: "exercise", defaultDuration: 30, ratingLabel: "intensity" },
      { id: "floss", label: "Floss", shape: "happened" },
    ],
  };
}

describe("slugifyTrackableId", () => {
  it("lowercases and converts spaces to dashes", () => {
    expect(slugifyTrackableId("PT")).toBe("pt");
    expect(slugifyTrackableId("trip planning")).toBe("trip-planning");
    expect(slugifyTrackableId("  Hot  Yoga  ")).toBe("hot-yoga");
  });
  it("strips illegal characters and trims separators", () => {
    expect(slugifyTrackableId("Café au lait!")).toBe("caf-au-lait");
    expect(slugifyTrackableId("--weird--")).toBe("weird");
  });
  it("returns empty string when nothing survives", () => {
    expect(slugifyTrackableId("!!!")).toBe("");
  });
});

describe("addTrackable", () => {
  it("adds + returns a new manifest, leaving the input untouched", () => {
    const cur = base();
    const next = addTrackable(cur, { id: "sleep", label: "Sleep", shape: "did", defaultDuration: 480, ratingLabel: "quality" });
    expect(next.trackables.map((t) => t.id)).toEqual(["coffee", "mood", "run", "floss", "sleep"]);
    expect(next.trackables[4]).toEqual({
      id: "sleep",
      label: "Sleep",
      shape: "did",
      defaultDuration: 480,
      ratingLabel: "quality",
    });
    expect(cur.trackables).toHaveLength(4); // immutable input
  });
  it("rejects duplicate id", () => {
    expect(() => addTrackable(base(), { id: "coffee", label: "Coffee 2", shape: "took" }))
      .toThrow(/already exists/);
  });
  it("rejects non-slug id and empty label", () => {
    expect(() => addTrackable(base(), { id: "Bad Id", label: "x", shape: "took" })).toThrow(/slug/);
    expect(() => addTrackable(base(), { id: "ok", label: "  ", shape: "took" })).toThrow(/label/);
  });
  it("rejects an unknown shape", () => {
    expect(() => addTrackable(base(), { id: "ok", label: "Ok", shape: "consumed" }))
      .toThrow(/shape must be one of took\|did\|happened\|rated/);
  });
  it("rejects non-positive defaults", () => {
    expect(() => addTrackable(base(), { id: "ok", label: "Ok", shape: "took", defaultAmount: 0 }))
      .toThrow(/defaultAmount/);
    expect(() => addTrackable(base(), { id: "ok", label: "Ok", shape: "did", defaultDuration: -5 }))
      .toThrow(/defaultDuration/);
    expect(() => addTrackable(base(), { id: "ok", label: "Ok", shape: "took", defaultUnit: "" }))
      .toThrow(/defaultUnit/);
  });
  it("accepts pins at creation", () => {
    const next = addTrackable(base(), {
      id: "edibles",
      label: "Edibles",
      shape: "took",
      defaultUnit: "mg",
      pinned: [{ label: "5mg", entries: [{ name: "amount", type: "number", value: 5, unit: "mg" }] }],
    });
    expect(next.trackables.find((t) => t.id === "edibles")!.pinned).toHaveLength(1);
  });
  it("accepts the reflective `noted` shape", () => {
    const next = addTrackable(base(), { id: "gratitude", label: "Gratitude", shape: "noted" });
    expect(next.trackables.find((t) => t.id === "gratitude")!.shape).toBe("noted");
  });
  it("round-trips view-render metadata (prompt/hint/refs)", () => {
    const next = addTrackable(base(), {
      id: "intention_followup",
      label: "Intention follow-up",
      shape: "noted",
      prompt: "How did {intention} go?",
      hint: "Be honest.",
      refs: [{ token: "intention", fromTrackable: "daily_intention", within: "day", entry: "note" }],
    });
    const t = next.trackables.find((x) => x.id === "intention_followup")!;
    expect(t.prompt).toBe("How did {intention} go?");
    expect(t.hint).toBe("Be honest.");
    expect(t.refs).toEqual([
      { token: "intention", fromTrackable: "daily_intention", within: "day", entry: "note" },
    ]);
  });
  it("drops empty refs[] and omits absent metadata", () => {
    const next = addTrackable(base(), { id: "plain", label: "Plain", shape: "noted", refs: [] });
    const t = next.trackables.find((x) => x.id === "plain")!;
    expect(t.refs).toBeUndefined();
    expect(t.prompt).toBeUndefined();
    expect(t.hint).toBeUndefined();
  });
  it("rejects malformed refs", () => {
    expect(() =>
      addTrackable(base(), { id: "bad", label: "Bad", shape: "noted", refs: [{ fromTrackable: "x", within: "day" }] }),
    ).toThrow(/token/);
    expect(() =>
      addTrackable(base(), { id: "bad", label: "Bad", shape: "noted", refs: [{ token: "t", fromTrackable: "x", within: "year" }] }),
    ).toThrow(/within/);
  });
});

describe("updateTrackable", () => {
  it("patches label/group/hidden", () => {
    const next = updateTrackable(base(), "coffee", { label: "Espresso", hidden: true });
    const t = next.trackables.find((x) => x.id === "coffee")!;
    expect(t.label).toBe("Espresso");
    expect(t.hidden).toBe(true);
    expect(t.shape).toBe("took"); // untouched
  });
  it("clears group with null", () => {
    const next = updateTrackable(base(), "run", { group: null });
    expect(next.trackables.find((x) => x.id === "run")!.group).toBeUndefined();
  });
  it("makes id/shape change a COMPILE error (structural immutability)", () => {
    // The patch type is the trackable's PAYLOAD keyspace, so the frozen identity
    // (`id`/`shape`) can't even be named — the type system rejects it, no
    // runtime throw. @ts-expect-error fails the build if either becomes nameable.
    // @ts-expect-error id is not part of the trackable payload patch
    expect(() => updateTrackable(base(), "coffee", { id: "espresso" })).not.toThrow();
    // @ts-expect-error shape is not part of the trackable payload patch
    expect(() => updateTrackable(base(), "coffee", { shape: "did" })).not.toThrow();
  });
  it("patches and clears prefill defaults", () => {
    const patched = updateTrackable(base(), "coffee", { defaultAmount: 12, defaultUnit: "ml" });
    const t = patched.trackables.find((x) => x.id === "coffee")!;
    expect(t.defaultAmount).toBe(12);
    expect(t.defaultUnit).toBe("ml");

    const cleared = updateTrackable(patched, "coffee", { defaultAmount: null, defaultUnit: null });
    const c = cleared.trackables.find((x) => x.id === "coffee")!;
    expect(c.defaultAmount).toBeUndefined();
    expect(c.defaultUnit).toBeUndefined();
  });
  it("patches and clears ratingLabel", () => {
    const next = updateTrackable(base(), "run", { ratingLabel: "effort" });
    expect(next.trackables.find((x) => x.id === "run")!.ratingLabel).toBe("effort");
    const cleared = updateTrackable(next, "run", { ratingLabel: null });
    expect(cleared.trackables.find((x) => x.id === "run")!.ratingLabel).toBeUndefined();
  });
  it("rejects invalid default values", () => {
    expect(() => updateTrackable(base(), "coffee", { defaultAmount: "lots" })).toThrow(/defaultAmount/);
    expect(() => updateTrackable(base(), "run", { defaultDuration: 0 })).toThrow(/defaultDuration/);
  });
  it("throws on unknown trackable", () => {
    expect(() => updateTrackable(base(), "nope", { label: "x" })).toThrow(/no trackable/);
  });
  it("patches and clears view-render metadata", () => {
    const withMeta = addTrackable(base(), { id: "win", label: "Win", shape: "noted" });
    const patched = updateTrackable(withMeta, "win", {
      prompt: "What went well?",
      refs: [{ token: "t", fromTrackable: "mood", within: "week" }],
    });
    const t = patched.trackables.find((x) => x.id === "win")!;
    expect(t.prompt).toBe("What went well?");
    expect(t.refs).toEqual([{ token: "t", fromTrackable: "mood", within: "week" }]);

    const cleared = updateTrackable(patched, "win", { prompt: "", refs: [] });
    const c = cleared.trackables.find((x) => x.id === "win")!;
    expect(c.prompt).toBeUndefined();
    expect(c.refs).toBeUndefined();
  });
});

describe("removeTrackable", () => {
  it("drops the trackable", () => {
    const next = removeTrackable(base(), "mood");
    expect(next.trackables.map((t) => t.id)).toEqual(["coffee", "run", "floss"]);
  });
  it("throws on unknown", () => {
    expect(() => removeTrackable(base(), "nope")).toThrow(/no trackable/);
  });
});

describe("reorderTrackables", () => {
  it("reorders to the given permutation", () => {
    const next = reorderTrackables(base(), ["mood", "floss", "coffee", "run"]);
    expect(next.trackables.map((t) => t.id)).toEqual(["mood", "floss", "coffee", "run"]);
  });
  it("rejects a non-permutation", () => {
    expect(() => reorderTrackables(base(), ["mood", "coffee"])).toThrow(/permutation/);
    expect(() => reorderTrackables(base(), ["mood", "mood", "coffee", "run"])).toThrow(/permutation/);
    expect(() => reorderTrackables(base(), ["mood", "coffee", "run", "ghost"])).toThrow(/unknown trackable id/);
  });
  it("preserves the rest of the manifest (goals must survive a trackable reorder)", () => {
    // Regression: a long-tail trackable drag routes through reorderTrackables.
    // It must not wipe the user's goals (which live alongside trackables in the
    // same manifest blob).
    const withGoals: LifeManifest = {
      ...base(),
      goals: [
        { id: "hydrate", label: "Hydrate", scope: { thing: "coffee" }, kind: "at_least", metric: "count", target: 1, period: "day" },
      ],
    };
    const next = reorderTrackables(withGoals, ["mood", "floss", "coffee", "run"]);
    expect(next.trackables.map((t) => t.id)).toEqual(["mood", "floss", "coffee", "run"]);
    expect(next.goals).toEqual(withGoals.goals);
  });
});

describe("reorderById (generic helper, shared by all four reorderX ops)", () => {
  const items = () => [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("rebuilds the list in the requested permutation, never mutating the input", () => {
    const cur = items();
    const out = reorderById(cur, ["c", "a", "b"], "view");
    expect(out.map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(cur.map((x) => x.id)).toEqual(["a", "b", "c"]); // input untouched
  });

  it("threads the noun into every error message", () => {
    expect(() => reorderById(items(), "nope", "goal")).toThrow(/order must be an array of goal ids/);
    expect(() => reorderById(items(), [1, 2, 3], "goal")).toThrow(/order must be an array of goal ids/);
    expect(() => reorderById(items(), ["a", "b"], "notification")).toThrow(
      /permutation of the 3 current notification ids/,
    );
    expect(() => reorderById(items(), ["a", "a", "b"], "view")).toThrow(/permutation of the 3 current view ids/);
    expect(() => reorderById(items(), ["a", "b", "ghost"], "trackable")).toThrow(
      /order references unknown trackable id "ghost"/,
    );
  });

  it("uses the invalid_order code for every rejection", () => {
    let err: ManifestError | undefined;
    try {
      reorderById(items(), ["a", "b"], "view");
    } catch (e) {
      err = e as ManifestError;
    }
    expect(err?.code).toBe("invalid_order");
  });
});

describe("patchOptionalString (shared set/clear dance)", () => {
  it("sets a non-empty string, clears on null/empty, throws otherwise", () => {
    const o: { greeting?: string } = { greeting: "hi" };
    patchOptionalString(o, "greeting", "hello", "greeting", "invalid_view");
    expect(o.greeting).toBe("hello");
    patchOptionalString(o, "greeting", "", "greeting", "invalid_view");
    expect(o.greeting).toBeUndefined();
    o.greeting = "back";
    patchOptionalString(o, "greeting", null, "greeting", "invalid_view");
    expect(o.greeting).toBeUndefined();
    expect(() => patchOptionalString(o, "greeting", 5, "greeting", "invalid_view")).toThrow(
      /greeting must be a string or null/,
    );
  });
});

describe("setPins / validatePins", () => {
  it("accepts a well-shaped number-entry pin", () => {
    const next = setPins(base(), "coffee", [
      { label: "Mug", entries: [{ name: "amount", type: "number", value: 12, unit: "oz" }] },
    ]);
    expect(next.trackables.find((t) => t.id === "coffee")!.pinned).toHaveLength(1);
  });
  it("accepts a legacy pin whose entry name is a historical one (dose, volume)", () => {
    // History-era entry names must keep replaying — readers are name-agnostic.
    const next = setPins(base(), "coffee", [
      { label: "8oz", entries: [{ name: "volume", type: "number", value: 8, unit: "oz" }] },
    ]);
    expect(next.trackables.find((t) => t.id === "coffee")!.pinned![0].entries[0])
      .toEqual({ name: "volume", type: "number", value: 8, unit: "oz" });
  });
  it("carries legacy category labels through verbatim", () => {
    const next = setPins(base(), "run", [
      { label: "Walk 30", entries: [{ name: "duration", type: "number", value: 30, unit: "min" }], labels: { category: "walk" } },
    ]);
    expect(next.trackables.find((t) => t.id === "run")!.pinned![0].labels).toEqual({ category: "walk" });
  });
  it("clearing pins removes the key", () => {
    const withPin = setPins(base(), "coffee", [{ entries: [{ name: "amount", type: "number", value: 8, unit: "oz" }] }]);
    const cleared = setPins(withPin, "coffee", []);
    expect(cleared.trackables.find((t) => t.id === "coffee")!.pinned).toBeUndefined();
  });

  describe("pin entry shape", () => {
    it("rejects an entry missing `type`", () => {
      expect(() => setPins(base(), "coffee", [{ entries: [{ name: "amount", value: 8, unit: "oz" }] }]))
        .toThrow(/must be \{type:"number"\}/);
    });
    it("rejects text entries (free-form, never replayable)", () => {
      expect(() => setPins(base(), "coffee", [{ entries: [{ name: "notes", type: "text", value: "lots" }] }]))
        .toThrow(/must be \{type:"number"\}/);
    });
    it("rejects a number entry whose value is not a number", () => {
      expect(() => setPins(base(), "coffee", [{ entries: [{ name: "amount", type: "number", value: "8", unit: "oz" }] }]))
        .toThrow(/value must be a finite number/);
    });
    it("rejects a number entry with no unit / empty unit", () => {
      expect(() => setPins(base(), "coffee", [{ entries: [{ name: "amount", type: "number", value: 8 }] }]))
        .toThrow(/non-empty unit/);
      expect(() => setPins(base(), "coffee", [{ entries: [{ name: "amount", type: "number", value: 8, unit: "" }] }]))
        .toThrow(/non-empty unit/);
    });
    it("rejects an empty entries[]", () => {
      expect(() => setPins(base(), "coffee", [{ entries: [] }])).toThrow(/non-empty array/);
    });
  });

  describe("rating pin canonicalization", () => {
    it("rejects a rating value outside 1..scale", () => {
      expect(() => setPins(base(), "mood", [{ entries: [{ name: "rating", type: "number", value: 6, unit: "rating" }] }]))
        .toThrow(/rating value must be a number in 1\.\.5/);
      expect(() => setPins(base(), "mood", [{ entries: [{ name: "rating", type: "number", value: 0, unit: "rating" }] }]))
        .toThrow(/rating value must be a number in 1\.\.5/);
    });
    it("forces the canonical rating shape (scale defaulted to 5)", () => {
      const next = setPins(base(), "mood", [{ entries: [{ name: "rating", type: "number", value: 4, unit: "rating" }] }]);
      expect(next.trackables.find((t) => t.id === "mood")!.pinned![0].entries[0])
        .toEqual({ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 });
    });
    it("respects an explicit valid scale", () => {
      const next = setPins(base(), "mood", [{ entries: [{ name: "rating", type: "number", value: 7, unit: "rating", scale: 10 }] }]);
      expect(next.trackables.find((t) => t.id === "mood")!.pinned![0].entries[0])
        .toEqual({ name: "rating", type: "number", value: 7, unit: "rating", scale: 10 });
    });
  });
});

describe("emptyManifest", () => {
  it("is a fresh empty manifest", () => {
    expect(emptyManifest()).toEqual({ trackables: [] });
  });
});

describe("ManifestError", () => {
  it("carries a stable code", () => {
    try {
      addTrackable(base(), { id: "ok", label: "Ok", shape: "nope" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
      expect((e as ManifestError).code).toBe("invalid_shape");
    }
  });
});

describe("sibling-key preservation (every manifest mutation keeps views/goals/notifications)", () => {
  // INVARIANT: every pure manifest op does a read-modify-write that preserves
  // ALL sibling keys — `goals`, `views`, `notifications` — touching only its
  // target. The original B1 regression was that the trackable ops returned a
  // bare `{ trackables }`, silently dropping these. A user with an explicit
  // `views: []` (Angela) would have reverted to DEFAULT_VIEWS on her first
  // trackable add/edit/remove/pin, and `goals` had already been dropping in
  // prod. `[]` is LOAD-BEARING (distinct from `undefined`): it must survive as
  // `[]`, not be dropped to undefined (which would re-enable the DEFAULT_*
  // fallback).
  function withSiblings(): LifeManifest {
    return {
      ...base(),
      goals: [
        { id: "hydrate", label: "Hydrate", scope: { thing: "coffee" }, kind: "at_least", metric: "count", target: 1, period: "day" },
      ],
      views: [], // explicit empty — must stay [], NOT default-fallback
      notifications: [], // explicit empty — must stay []
    };
  }

  function assertSiblings(next: LifeManifest, m: LifeManifest) {
    expect(next.goals).toEqual(m.goals);
    expect(next.views, "views: [] must survive as [], not be dropped to undefined").toEqual([]);
    expect(next.notifications, "notifications: [] must survive as []").toEqual([]);
  }

  describe("trackable ops", () => {
    it("addTrackable preserves goals/views/notifications", () => {
      const m = withSiblings();
      assertSiblings(addTrackable(m, { id: "sleep", label: "Sleep", shape: "did" }), m);
    });
    it("updateTrackable preserves them", () => {
      const m = withSiblings();
      assertSiblings(updateTrackable(m, "coffee", { label: "Coffee II" }), m);
    });
    it("removeTrackable preserves them", () => {
      const m = withSiblings();
      assertSiblings(removeTrackable(m, "floss"), m);
    });
    it("reorderTrackables preserves them", () => {
      const m = withSiblings();
      assertSiblings(reorderTrackables(m, ["mood", "floss", "coffee", "run"]), m);
    });
    it("setPins preserves them", () => {
      const m = withSiblings();
      const next = setPins(m, "coffee", [{ entries: [{ name: "amount", type: "number", value: 8, unit: "oz" }] }]);
      assertSiblings(next, m);
    });
  });

  describe("goal ops (preserve trackables/views/notifications)", () => {
    function assertNonGoalSiblings(next: LifeManifest, m: LifeManifest) {
      expect(next.trackables).toEqual(m.trackables);
      expect(next.views).toEqual([]);
      expect(next.notifications).toEqual([]);
    }
    it("addGoal preserves trackables/views/notifications", () => {
      const m = withSiblings();
      const next = addGoal(m, { id: "floss-daily", label: "Floss", scope: { thing: "floss" }, kind: "frequency", metric: "days", target: 5, period: "week" });
      assertNonGoalSiblings(next, m);
    });
    it("updateGoal preserves them", () => {
      const m = withSiblings();
      assertNonGoalSiblings(updateGoal(m, "hydrate", { target: 3 }), m);
    });
    it("removeGoal preserves them", () => {
      const m = withSiblings();
      assertNonGoalSiblings(removeGoal(m, "hydrate"), m);
    });
    it("reorderGoals preserves them", () => {
      const m: LifeManifest = {
        ...withSiblings(),
        goals: [
          { id: "hydrate", label: "Hydrate", scope: { thing: "coffee" }, kind: "at_least", metric: "count", target: 1, period: "day" },
          { id: "move", label: "Move", scope: { thing: "run" }, kind: "frequency", metric: "days", target: 3, period: "week" },
        ],
      };
      assertNonGoalSiblings(reorderGoals(m, ["move", "hydrate"]), m);
    });
  });
});
