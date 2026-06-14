import { describe, it, expect } from "vitest";
import { addGoal, updateGoal, removeGoal, manifestGoals } from "./life-goal-ops";
import { ManifestError } from "./life-manifest-ops";
import type { LifeManifest, LifeGoal } from "./types/life";

function base(): LifeManifest {
  return {
    trackables: [
      { id: "water", label: "Water", shape: "took", defaultUnit: "oz" },
      { id: "run", label: "Run", shape: "did", group: "exercise" },
      { id: "walk", label: "Walk", shape: "did", group: "exercise" },
      { id: "floss", label: "Floss", shape: "happened" },
    ],
    goals: [
      { id: "hydrate", label: "Hydrate", scope: { thing: "water" }, kind: "at_least", metric: "sum", unit: "oz", target: 64, period: "day" },
    ],
  };
}

const VALID = {
  id: "move",
  label: "Move daily",
  scope: { group: "exercise" },
  kind: "frequency" as const,
  metric: "days" as const,
  target: 5,
  period: "week" as const,
};

describe("addGoal", () => {
  it("appends + returns a new manifest, leaving the input untouched", () => {
    const cur = base();
    const next = addGoal(cur, VALID);
    expect(manifestGoals(next).map((g) => g.id)).toEqual(["hydrate", "move"]);
    expect(manifestGoals(cur)).toHaveLength(1); // immutable input
  });

  it("seeds goals[] on a manifest that has none", () => {
    const next = addGoal({ trackables: [] }, VALID);
    expect(manifestGoals(next)).toHaveLength(1);
  });

  it("rejects duplicate id", () => {
    expect(() => addGoal(base(), { ...VALID, id: "hydrate" })).toThrow(/already exists/);
  });

  it("rejects non-slug id", () => {
    expect(() => addGoal(base(), { ...VALID, id: "Bad Id" })).toThrow(/slug/);
  });

  it("requires unit when metric is sum", () => {
    let err: ManifestError | undefined;
    try {
      addGoal(base(), { id: "g", label: "G", scope: { thing: "water" }, kind: "at_least", metric: "sum", target: 64, period: "day" });
    } catch (e) { err = e as ManifestError; }
    expect(err).toBeInstanceOf(ManifestError);
    expect(err?.code).toBe("invalid_goal");
    expect(err?.message).toMatch(/sum.*requires.*unit/i);
  });

  it("drops unit when metric is not sum", () => {
    const next = addGoal(base(), { id: "g", label: "G", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 1, period: "day", unit: "oz" });
    expect(manifestGoals(next).find((g) => g.id === "g")?.unit).toBeUndefined();
  });

  it("forces metric=days for frequency goals", () => {
    expect(() => addGoal(base(), { ...VALID, id: "g2", metric: "count" })).toThrow(/frequency.*days/i);
  });

  it("rejects scope that is neither thing nor group, or both", () => {
    expect(() => addGoal(base(), { ...VALID, id: "g3", scope: {} })).toThrow(/exactly one/);
    expect(() => addGoal(base(), { ...VALID, id: "g4", scope: { thing: "water", group: "exercise" } })).toThrow(/exactly one/);
  });

  it("rejects non-positive target and bad enums", () => {
    expect(() => addGoal(base(), { ...VALID, id: "g5", target: 0 })).toThrow(/target/);
    expect(() => addGoal(base(), { ...VALID, id: "g6", kind: "nope" })).toThrow(/kind/);
    expect(() => addGoal(base(), { ...VALID, id: "g7", period: "month" })).toThrow(/period/);
  });
});

describe("updateGoal", () => {
  it("patches label/target/period and re-validates", () => {
    const next = updateGoal(base(), "hydrate", { label: "Drink up", target: 80, period: "week" });
    const g = manifestGoals(next).find((x) => x.id === "hydrate") as LifeGoal;
    expect(g.label).toBe("Drink up");
    expect(g.target).toBe(80);
    expect(g.period).toBe("week");
    expect(g.unit).toBe("oz"); // preserved
  });

  it("rejects id/scope/kind/metric mutation as immutable", () => {
    expect(() => updateGoal(base(), "hydrate", { id: "other" })).toThrow(/immutable/);
    expect(() => updateGoal(base(), "hydrate", { scope: { thing: "run" } })).toThrow(/immutable/);
    expect(() => updateGoal(base(), "hydrate", { kind: "at_most" })).toThrow(/immutable/);
    expect(() => updateGoal(base(), "hydrate", { metric: "count" })).toThrow(/immutable/);
  });

  it("allows a no-op scope patch equal to the existing scope", () => {
    const next = updateGoal(base(), "hydrate", { scope: { thing: "water" }, target: 70 });
    expect(manifestGoals(next).find((g) => g.id === "hydrate")?.target).toBe(70);
  });

  it("rejects patches that break a cross-field invariant", () => {
    // sum goal: clearing unit is impossible via patch (unit stays), but a bad
    // target still re-validates.
    expect(() => updateGoal(base(), "hydrate", { target: -1 })).toThrow(/target/);
  });

  it("throws when goal not found", () => {
    let err: ManifestError | undefined;
    try { updateGoal(base(), "nope", { target: 1 }); } catch (e) { err = e as ManifestError; }
    expect(err?.code).toBe("goal_not_found");
  });
});

describe("removeGoal", () => {
  it("removes the goal, manifest-only", () => {
    const next = removeGoal(base(), "hydrate");
    expect(manifestGoals(next)).toHaveLength(0);
    expect(next.trackables).toHaveLength(4); // trackables untouched
  });
  it("throws when absent", () => {
    expect(() => removeGoal(base(), "nope")).toThrow(/no goal/);
  });
});
