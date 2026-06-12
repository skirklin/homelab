import { describe, it, expect } from "vitest";
import {
  addTrackable,
  updateTrackable,
  removeTrackable,
  reorderTrackables,
  setPins,
  slugifyTrackableId,
  ManifestError,
  emptyManifest,
} from "./life-manifest-ops";
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
  it("rejects id change (immutable)", () => {
    expect(() => updateTrackable(base(), "coffee", { id: "espresso" })).toThrow(/immutable/);
  });
  it("rejects shape change (immutable)", () => {
    expect(() => updateTrackable(base(), "coffee", { shape: "did" })).toThrow(/shape is immutable/);
  });
  it("accepts a redundant same-shape patch", () => {
    const next = updateTrackable(base(), "coffee", { shape: "took", label: "Coffee!" });
    expect(next.trackables.find((x) => x.id === "coffee")!.label).toBe("Coffee!");
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
