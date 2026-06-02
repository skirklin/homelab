import { describe, it, expect } from "vitest";
import {
  addTrackable,
  updateTrackable,
  removeTrackable,
  reorderTrackables,
  setPins,
  validateField,
  ManifestError,
  emptyManifest,
} from "./life-manifest-ops";
import type { LifeManifest } from "./types/life";

function base(): LifeManifest {
  return {
    trackables: [
      { id: "water", label: "Water", group: "body", fields: [{ key: "volume", type: "number", unit: "oz" }] },
      { id: "mood", label: "Mood", group: "mind", fields: [{ key: "rating", type: "rating", scale: 5 }] },
      {
        id: "movement",
        label: "Movement",
        fields: [
          { key: "kind", type: "category", options: ["walk", "run"] },
          { key: "duration", type: "number", unit: "min" },
        ],
      },
    ],
  };
}

describe("validateField", () => {
  it("accepts each valid type", () => {
    expect(validateField({ key: "a", type: "number", unit: "oz" }).type).toBe("number");
    expect(validateField({ key: "b", type: "rating", scale: 10 }).scale).toBe(10);
    expect(validateField({ key: "c", type: "text" }).type).toBe("text");
    expect(validateField({ key: "d", type: "bool" }).type).toBe("bool");
    expect(validateField({ key: "e", type: "category", options: ["x", "y"] }).options).toEqual(["x", "y"]);
  });
  it("rejects category without options", () => {
    expect(() => validateField({ key: "e", type: "category" })).toThrow(ManifestError);
    expect(() => validateField({ key: "e", type: "category", options: [] })).toThrow(/non-empty options/);
  });
  it("rejects bad type and bad key", () => {
    expect(() => validateField({ key: "e", type: "blob" })).toThrow(/field.type must be/);
    expect(() => validateField({ key: "Bad Key", type: "text" })).toThrow(/slug/);
  });
});

describe("addTrackable", () => {
  it("adds + returns a new manifest, leaving the input untouched", () => {
    const cur = base();
    const next = addTrackable(cur, { id: "sleep", label: "Sleep", fields: [{ key: "duration", type: "number", unit: "min" }] });
    expect(next.trackables.map((t) => t.id)).toEqual(["water", "mood", "movement", "sleep"]);
    expect(cur.trackables).toHaveLength(3); // immutable input
  });
  it("rejects duplicate id", () => {
    expect(() => addTrackable(base(), { id: "water", label: "Water 2", fields: [{ key: "x", type: "number" }] }))
      .toThrow(/already exists/);
  });
  it("rejects non-slug id and empty label", () => {
    expect(() => addTrackable(base(), { id: "Bad Id", label: "x", fields: [{ key: "x", type: "number" }] })).toThrow(/slug/);
    expect(() => addTrackable(base(), { id: "ok", label: "  ", fields: [{ key: "x", type: "number" }] })).toThrow(/label/);
  });
  it("rejects duplicate field keys", () => {
    expect(() => addTrackable(base(), { id: "ok", label: "Ok", fields: [{ key: "x", type: "number" }, { key: "x", type: "text" }] }))
      .toThrow(/duplicate field.key/);
  });
});

describe("updateTrackable", () => {
  it("patches label/group/hidden", () => {
    const next = updateTrackable(base(), "water", { label: "H2O", hidden: true });
    const t = next.trackables.find((x) => x.id === "water")!;
    expect(t.label).toBe("H2O");
    expect(t.hidden).toBe(true);
  });
  it("clears group with null", () => {
    const next = updateTrackable(base(), "water", { group: null });
    expect(next.trackables.find((x) => x.id === "water")!.group).toBeUndefined();
  });
  it("rejects id change (immutable)", () => {
    expect(() => updateTrackable(base(), "water", { id: "h2o" })).toThrow(/immutable/);
  });
  it("allows adding a new field", () => {
    const next = updateTrackable(base(), "water", {
      fields: [{ key: "volume", type: "number", unit: "oz" }, { key: "temp", type: "category", options: ["cold", "warm"] }],
    });
    expect(next.trackables.find((x) => x.id === "water")!.fields.map((f) => f.key)).toEqual(["volume", "temp"]);
  });
  it("allows editing an existing field's label/unit (same key+type)", () => {
    const next = updateTrackable(base(), "water", { fields: [{ key: "volume", type: "number", unit: "ml", label: "Volume" }] });
    const f = next.trackables.find((x) => x.id === "water")!.fields[0];
    expect(f.unit).toBe("ml");
    expect(f.label).toBe("Volume");
  });
  it("rejects removing an existing field key", () => {
    expect(() => updateTrackable(base(), "movement", { fields: [{ key: "kind", type: "category", options: ["walk"] }] }))
      .toThrow(/cannot be removed/);
  });
  it("rejects retyping an existing field key", () => {
    expect(() => updateTrackable(base(), "water", { fields: [{ key: "volume", type: "text" }] }))
      .toThrow(/cannot change type/);
  });
  it("throws on unknown trackable", () => {
    expect(() => updateTrackable(base(), "nope", { label: "x" })).toThrow(/no trackable/);
  });
});

describe("removeTrackable", () => {
  it("drops the trackable", () => {
    const next = removeTrackable(base(), "mood");
    expect(next.trackables.map((t) => t.id)).toEqual(["water", "movement"]);
  });
  it("throws on unknown", () => {
    expect(() => removeTrackable(base(), "nope")).toThrow(/no trackable/);
  });
});

describe("reorderTrackables", () => {
  it("reorders to the given permutation", () => {
    const next = reorderTrackables(base(), ["mood", "movement", "water"]);
    expect(next.trackables.map((t) => t.id)).toEqual(["mood", "movement", "water"]);
  });
  it("rejects a non-permutation", () => {
    expect(() => reorderTrackables(base(), ["mood", "water"])).toThrow(/permutation/);
    expect(() => reorderTrackables(base(), ["mood", "mood", "water"])).toThrow(/permutation/);
    expect(() => reorderTrackables(base(), ["mood", "water", "ghost"])).toThrow(/unknown trackable id/);
  });
});

describe("setPins / validatePins", () => {
  it("accepts a pin whose entries name field keys", () => {
    const next = setPins(base(), "water", [
      { label: "Glass", entries: [{ name: "volume", type: "number", value: 8, unit: "oz" }] },
    ]);
    expect(next.trackables.find((t) => t.id === "water")!.pinned).toHaveLength(1);
  });
  it("accepts a pin with a category label matching a category field", () => {
    const next = setPins(base(), "movement", [
      { label: "Walk 30", entries: [{ name: "duration", type: "number", value: 30, unit: "min" }], labels: { kind: "walk" } },
    ]);
    expect(next.trackables.find((t) => t.id === "movement")!.pinned).toHaveLength(1);
  });
  it("rejects a pin whose entry name is not a field key", () => {
    expect(() => setPins(base(), "water", [{ entries: [{ name: "ghost", type: "number", value: 1, unit: "oz" }] }]))
      .toThrow(/must match a measurement field.key/);
  });
  it("rejects a pin whose label key is not a category field", () => {
    expect(() => setPins(base(), "movement", [
      { entries: [{ name: "duration", type: "number", value: 30, unit: "min" }], labels: { bogus: "x" } },
    ])).toThrow(/must match a category field.key/);
  });
  it("clearing pins removes the key", () => {
    const withPin = setPins(base(), "water", [{ entries: [{ name: "volume", type: "number", value: 8, unit: "oz" }] }]);
    const cleared = setPins(withPin, "water", []);
    expect(cleared.trackables.find((t) => t.id === "water")!.pinned).toBeUndefined();
  });
});

describe("emptyManifest", () => {
  it("is a fresh empty manifest", () => {
    expect(emptyManifest()).toEqual({ trackables: [] });
  });
});
