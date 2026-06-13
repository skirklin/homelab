/**
 * Migration-execution test for
 * infra/pocketbase/pb_migrations/20260612_210800_life_manifest_shape_vocab.js
 * — the field-schema → shape/vocab-row manifest rewrite.
 *
 * Same vm-sandbox strategy as task-tags.test.ts: load the REAL migration
 * source, register a fake `migrate` that captures up/down, then (a) drive the
 * pure transform exposed via `globalThis.__lifeManifestShapeTransform` and
 * (b) run up() against a stub app whose record returns the manifest in the
 * goja byte-array form, proving the unwrapPbJson path.
 *
 * The fixture is the REAL production manifest (the BACKFILL_MANIFEST block in
 * 20260601_191856_life_manifest_column.js, plus the coffee pin added at
 * runtime) so the generic rules are verified against every trackable that
 * actually exists in prod.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  here,
  "../../../../infra/pocketbase/pb_migrations/20260612_210800_life_manifest_shape_vocab.js",
);

interface VocabRow {
  id: string;
  label: string;
  shape: string;
  group?: string;
  defaultUnit?: string;
  defaultAmount?: number;
  defaultDuration?: number;
  ratingLabel?: string;
  hidden?: boolean;
  pinned?: unknown[];
}

interface Transform {
  transformManifest: (m: unknown) => { trackables: VocabRow[] } | null;
  slugifyTrackableId: (s: string) => string;
}

let up: (app: unknown) => void;
let down: (app: unknown) => void;
let transform: Transform;

beforeAll(() => {
  const src = readFileSync(MIGRATION, "utf8");
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    migrate: (u: typeof up, d: typeof down) => {
      up = u;
      down = d;
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: MIGRATION });
  transform = sandbox.__lifeManifestShapeTransform as Transform;
  expect(transform).toBeDefined();
  expect(up).toBeDefined();
  expect(down).toBeDefined();
});

// ---------------------------------------------------------------------------
// Fixture: the production manifest (scott). Mirrors the BACKFILL_MANIFEST in
// 20260601_191856_life_manifest_column.js + the runtime-added coffee pin.
// ---------------------------------------------------------------------------
const mgPin = (label: string, name: string, value: number, unit: string) => ({
  label,
  entries: [{ name, type: "number", value, unit }],
});

function prodManifest() {
  return {
    trackables: [
      { id: "vyvanse", label: "Vyvanse", group: "medical", fields: [{ key: "dose", type: "number", unit: "mg", defaultValue: 30 }] },
      { id: "vitamins", label: "Vitamins", group: "medical", hidden: true, fields: [{ key: "count", type: "number", unit: "ct", defaultValue: 1 }] },
      { id: "ibuprofin", label: "Ibuprofin", group: "medical", hidden: true, fields: [{ key: "dose", type: "number", unit: "mg", defaultValue: 400 }] },
      {
        id: "edibles", label: "Edibles", group: "consumables",
        fields: [{ key: "dose", type: "number", unit: "mg", defaultValue: 5 }],
        pinned: [mgPin("2.5mg", "dose", 2.5, "mg"), mgPin("5mg", "dose", 5, "mg"), mgPin("10mg", "dose", 10, "mg")],
      },
      { id: "alcohol", label: "Alcohol", group: "consumables", fields: [{ key: "drinks", type: "number", unit: "drinks", defaultValue: 1 }] },
      {
        id: "coffee", label: "Coffee", group: "consumables",
        fields: [{ key: "volume", type: "number", unit: "oz", defaultValue: 8 }],
        pinned: [mgPin("8 oz", "volume", 8, "oz")],
      },
      { id: "poop", label: "Poop", group: "bio", fields: [{ key: "count", type: "number", unit: "ct", defaultValue: 1 }] },
      { id: "wank", label: "Wank", group: "bio", fields: [{ key: "count", type: "number", unit: "ct", defaultValue: 1 }] },
      { id: "sex", label: "Boink", group: "bio", fields: [{ key: "count", type: "number", unit: "ct", defaultValue: 1 }] },
      { id: "floss", label: "Floss", fields: [{ key: "count", type: "number", unit: "ct", defaultValue: 1 }] },
      {
        id: "sleep", label: "Sleep", group: "time-based",
        fields: [
          { key: "duration", type: "number", unit: "min", defaultValue: 480 },
          { key: "notes", type: "text", optional: true },
        ],
        pinned: [mgPin("7h", "duration", 420, "min"), mgPin("8h", "duration", 480, "min"), mgPin("9h", "duration", 540, "min")],
      },
      { id: "sleep_quality", label: "Sleep quality", group: "time-based", fields: [{ key: "rating", type: "rating", scale: 5 }] },
      {
        id: "exercise", label: "Exercise", group: "time-based",
        fields: [
          { key: "duration", type: "number", unit: "min", defaultValue: 30 },
          { key: "category", type: "category", options: ["walk", "run", "bike", "PT", "lift", "yoga", "other"] },
          { key: "intensity", type: "rating", scale: 5, optional: true },
        ],
      },
      {
        id: "focus", label: "Focus", group: "time-based",
        fields: [
          { key: "duration", type: "number", unit: "min", defaultValue: 25 },
          { key: "category", type: "category", options: ["chinese", "coding", "learning", "trip planning"] },
        ],
      },
      { id: "mood", label: "Mood", group: "ratings", hidden: true, fields: [{ key: "rating", type: "rating", scale: 5 }] },
      { id: "content", label: "Content", group: "ratings", hidden: true, fields: [{ key: "rating", type: "rating", scale: 5 }] },
    ],
  };
}

function byId(rows: VocabRow[]): Record<string, VocabRow> {
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

describe("transformManifest — production manifest", () => {
  it("maps every prod trackable per the shape rules", () => {
    const next = transform.transformManifest(prodManifest());
    expect(next).not.toBeNull();
    const rows = byId(next!.trackables);

    // took: other single number fields. Legacy layout groups (medical,
    // consumables, ...) are dropped — group is now a semantic rollup.
    expect(rows.vyvanse).toEqual({ id: "vyvanse", label: "Vyvanse", shape: "took", defaultUnit: "mg", defaultAmount: 30 });
    expect(rows.ibuprofin).toEqual({ id: "ibuprofin", label: "Ibuprofin", shape: "took", defaultUnit: "mg", defaultAmount: 400, hidden: true });
    expect(rows.alcohol).toEqual({ id: "alcohol", label: "Alcohol", shape: "took", defaultUnit: "drinks", defaultAmount: 1 });
    expect(rows.edibles).toMatchObject({ shape: "took", defaultUnit: "mg", defaultAmount: 5 });
    expect(rows.edibles.pinned).toHaveLength(3); // pins preserved as-is
    expect(rows.coffee).toMatchObject({ shape: "took", defaultUnit: "oz", defaultAmount: 8 });
    expect(rows.coffee.pinned).toHaveLength(1);

    // happened: ct counters with defaultValue 1 (hidden preserved)
    expect(rows.vitamins).toEqual({ id: "vitamins", label: "Vitamins", shape: "happened", hidden: true });
    for (const id of ["poop", "wank", "sex", "floss"]) {
      expect(rows[id].shape).toBe("happened");
    }
    expect(rows.sex.label).toBe("Boink");

    // did: sleep keeps its pins, inherits duration default, gains
    // ratingLabel "quality" (sleep_quality merges into it later). Its old
    // "time-based" layout group is dropped like the rest.
    expect(rows.sleep).toMatchObject({ shape: "did", defaultDuration: 480, ratingLabel: "quality" });
    expect(rows.sleep.group).toBeUndefined();
    expect(rows.sleep.pinned).toHaveLength(3);

    // rated: singles; sleep_quality additionally hidden.
    expect(rows.sleep_quality).toMatchObject({ shape: "rated", hidden: true });
    expect(rows.mood).toMatchObject({ shape: "rated", hidden: true });
    expect(rows.content).toMatchObject({ shape: "rated", hidden: true });
  });

  it("drops ALL legacy layout groups — only exploded husks + children carry a group (their own rollup)", () => {
    const next = transform.transformManifest(prodManifest())!;
    const groups = new Set(next.trackables.filter((t) => t.group !== undefined).map((t) => t.group));
    // No medical/consumables/bio/time-based/ratings junk rollups survive.
    expect([...groups].sort()).toEqual(["exercise", "focus"]);
    for (const t of next.trackables) {
      if (t.group !== undefined) {
        // group is always a trackable id (the rollup parent), never a layout bucket.
        expect(["exercise", "focus"]).toContain(t.group);
      }
    }
  });

  it("explodes exercise into per-thing did rows grouped under 'exercise'", () => {
    const next = transform.transformManifest(prodManifest())!;
    const rows = byId(next.trackables);

    // Kept husk: hidden, still did-shaped, retains defaults, and joins its
    // OWN rollup (group "exercise", NOT the legacy "time-based" layout group)
    // so historical subjectId:"exercise" events appear in "exercise (all)"
    // from day one.
    expect(rows.exercise).toMatchObject({ shape: "did", hidden: true, defaultDuration: 30, ratingLabel: "intensity", group: "exercise" });

    for (const [id, label] of [["walk", "walk"], ["run", "run"], ["bike", "bike"], ["pt", "PT"], ["lift", "lift"], ["yoga", "yoga"], ["other", "other"]] as const) {
      expect(rows[id]).toEqual({
        id, label, shape: "did", group: "exercise", defaultDuration: 30, ratingLabel: "intensity",
      });
    }
  });

  it("explodes focus (no rating field → no ratingLabel; 'trip planning' slugs to trip-planning)", () => {
    const next = transform.transformManifest(prodManifest())!;
    const rows = byId(next.trackables);

    expect(rows.focus).toMatchObject({ shape: "did", hidden: true, defaultDuration: 25, group: "focus" });
    expect(rows.focus.ratingLabel).toBeUndefined();

    for (const [id, label] of [["chinese", "chinese"], ["coding", "coding"], ["learning", "learning"], ["trip-planning", "trip planning"]] as const) {
      expect(rows[id]).toEqual({ id, label, shape: "did", group: "focus", defaultDuration: 25 });
    }
  });

  it("keeps exploded children adjacent to their kept parent (manifest order)", () => {
    const next = transform.transformManifest(prodManifest())!;
    const ids = next.trackables.map((t) => t.id);
    const ex = ids.indexOf("exercise");
    expect(ids.slice(ex, ex + 8)).toEqual(["exercise", "walk", "run", "bike", "pt", "lift", "yoga", "other"]);
    // 16 originals + 7 exercise things + 4 focus things
    expect(ids).toHaveLength(27);
    expect(new Set(ids).size).toBe(27); // no id collisions
  });
});

describe("transformManifest — generic / edge rules", () => {
  it("maps the OLD default starter set (water/mood/note/movement/floss)", () => {
    const next = transform.transformManifest({
      trackables: [
        { id: "water", label: "Water", group: "body", fields: [{ key: "volume", type: "number", unit: "oz", defaultValue: 8 }] },
        { id: "mood", label: "Mood", group: "mind", fields: [{ key: "rating", type: "rating", scale: 5 }] },
        { id: "note", label: "Note", group: "mind", fields: [{ key: "text", type: "text" }] },
        {
          id: "movement", label: "Movement", group: "body",
          fields: [
            { key: "kind", type: "category", options: ["walk", "run", "bike", "lift", "yoga", "other"] },
            { key: "duration", type: "number", unit: "min", defaultValue: 30 },
          ],
        },
        { id: "floss", label: "Floss", group: "body", fields: [{ key: "done", type: "bool", defaultValue: 1 }] },
      ],
    })!;
    const rows = byId(next.trackables);
    expect(rows.water).toMatchObject({ shape: "took", defaultUnit: "oz", defaultAmount: 8 });
    expect(rows.water.group).toBeUndefined(); // legacy "body" layout group dropped
    expect(rows.mood.shape).toBe("rated");
    expect(rows.note.shape).toBe("happened"); // text-only fallback
    expect(rows.movement).toMatchObject({ shape: "did", hidden: true, group: "movement" });
    expect(rows.walk).toMatchObject({ shape: "did", group: "movement", defaultDuration: 30 });
    expect(rows.floss.shape).toBe("happened"); // bool → happened
  });

  it("drops junk rows (null / non-object / missing id) instead of throwing", () => {
    const next = transform.transformManifest({
      trackables: [
        null,
        { id: "water", label: "Water", fields: [{ key: "volume", type: "number", unit: "oz", defaultValue: 8 }] },
        { label: "No id", fields: [{ key: "count", type: "number", unit: "ct" }] },
        42,
        { id: 7, label: "Numeric id", fields: [] },
      ],
    })!;
    expect(next).not.toBeNull();
    expect(next.trackables).toHaveLength(1);
    expect(next.trackables[0]).toMatchObject({ id: "water", shape: "took", defaultUnit: "oz", defaultAmount: 8 });
  });

  it("a ct field with a non-1 default is a took, not a happened", () => {
    const next = transform.transformManifest({
      trackables: [{ id: "pills", label: "Pills", fields: [{ key: "count", type: "number", unit: "ct", defaultValue: 2 }] }],
    })!;
    expect(next.trackables[0]).toMatchObject({ shape: "took", defaultUnit: "ct", defaultAmount: 2 });
  });

  it("collision-guards an exploded id against an existing trackable id", () => {
    const next = transform.transformManifest({
      trackables: [
        { id: "walk", label: "Walk", fields: [{ key: "count", type: "number", unit: "ct", defaultValue: 1 }] },
        {
          id: "exercise", label: "Exercise",
          fields: [
            { key: "duration", type: "number", unit: "min", defaultValue: 30 },
            { key: "category", type: "category", options: ["walk", "run"] },
          ],
        },
      ],
    })!;
    const ids = next.trackables.map((t) => t.id);
    expect(ids).toContain("walk"); // the original happened row
    expect(ids).toContain("exercise-walk"); // the exploded one, deduped
    expect(ids).toContain("run");
  });

  it("is idempotent: a transformed manifest returns null (no rewrite)", () => {
    const first = transform.transformManifest(prodManifest())!;
    expect(transform.transformManifest(first)).toBeNull();
  });

  it("returns null for empty/garbage manifests", () => {
    expect(transform.transformManifest(null)).toBeNull();
    expect(transform.transformManifest({})).toBeNull();
    expect(transform.transformManifest({ trackables: [] })).toBeNull();
  });
});

describe("up() — byte-array manifest column (goja []byte footgun)", () => {
  function makeStubApp(manifestRaw: unknown) {
    const saved: unknown[] = [];
    const record = {
      values: { manifest: manifestRaw } as Record<string, unknown>,
      get(k: string) { return this.values[k]; },
      set(k: string, v: unknown) { this.values[k] = v; },
    };
    return {
      record,
      saved,
      findRecordsByFilter: () => [record],
      save(r: unknown) { saved.push(r); },
    };
  }

  it("unwraps a byte-array manifest, transforms, and saves", () => {
    const json = JSON.stringify(prodManifest());
    const bytes = Array.from(json).map((c) => c.charCodeAt(0));
    const app = makeStubApp(bytes);
    up(app);
    expect(app.saved).toHaveLength(1);
    const written = app.record.values.manifest as { trackables: VocabRow[] };
    expect(written.trackables.some((t) => t.id === "trip-planning")).toBe(true);
  });

  it("skips logs whose manifest is already new-model (no save)", () => {
    const transformed = transform.transformManifest(prodManifest())!;
    const app = makeStubApp(JSON.stringify(transformed));
    up(app);
    expect(app.saved).toHaveLength(0);
  });

  it("skips null/empty manifests (no save)", () => {
    const app = makeStubApp(null);
    up(app);
    expect(app.saved).toHaveLength(0);
  });
});
