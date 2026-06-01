/**
 * P1 backfill correctness — the riskiest surface is keying each backfilled
 * trackable's primary field to the HISTORICAL entry name so scott's
 * pre-migration `life_events` keep aggregating after `primaryEntryName` goes
 * away in P2 (apps/life/ROADMAP.md "Risks": primaryEntryName removal).
 */
import { describe, it, expect } from "vitest";
import { backfillManifest, backfillTrackable } from "./manifest-backfill";
import { TRACKABLES } from "../trackables";
import { primaryEntryName } from "./format";
// The manifest literal the PB migration inlines (PB v0.25 migrations can't
// require() a module, so the payload is embedded between GENERATED markers).
// Parse it straight out of the migration source and compare below.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function readMigrationManifest(): unknown {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationPath = resolve(
    here,
    "../../../../../infra/pocketbase/pb_migrations/20260601_191856_life_manifest_column.js",
  );
  const src = readFileSync(migrationPath, "utf8");
  const m = src.match(
    /BEGIN GENERATED MANIFEST[^\n]*\*\/\s*const BACKFILL_MANIFEST = ([\s\S]*?);\s*\/\* END GENERATED MANIFEST/,
  );
  if (!m) throw new Error("Could not find GENERATED MANIFEST block in the migration");
  return JSON.parse(m[1]);
}
const migrationManifest = readMigrationManifest();

describe("backfillManifest — 1:1 with TRACKABLES, ids + historical keys intact", () => {
  it("produces exactly one trackable per hardcoded TRACKABLE, ids preserved in order", () => {
    const m = backfillManifest();
    expect(m.trackables).toHaveLength(TRACKABLES.length);
    expect(m.trackables.map((t) => t.id)).toEqual(TRACKABLES.map((t) => t.id));
  });

  it("sets fields[0].key to primaryEntryName(id) for every trackable (history join key)", () => {
    for (const t of TRACKABLES) {
      const bt = backfillTrackable(t);
      expect(bt.fields[0].key).toBe(primaryEntryName(t.id));
    }
  });

  it("preserves hidden + group", () => {
    for (const t of TRACKABLES) {
      const bt = backfillTrackable(t);
      expect(bt.group).toBe(t.group);
      expect(bt.hidden).toBe(t.hidden);
    }
  });

  it("maps rating-unit trackables to a rating field (scale 5), others to number with unit", () => {
    const mood = backfillTrackable(TRACKABLES.find((t) => t.id === "mood")!);
    expect(mood.fields[0]).toMatchObject({ key: "rating", type: "rating", scale: 5 });

    const vyvanse = backfillTrackable(TRACKABLES.find((t) => t.id === "vyvanse")!);
    expect(vyvanse.fields[0]).toMatchObject({ key: "dose", type: "number", unit: "mg", defaultValue: 30 });

    const alcohol = backfillTrackable(TRACKABLES.find((t) => t.id === "alcohol")!);
    expect(alcohol.fields[0]).toMatchObject({ key: "drinks", type: "number", unit: "drinks" });

    const coffee = backfillTrackable(TRACKABLES.find((t) => t.id === "coffee")!);
    expect(coffee.fields[0].key).toBe("volume");
  });

  it("maps categories → a category field keyed 'category' (historical labels.category)", () => {
    const exercise = backfillTrackable(TRACKABLES.find((t) => t.id === "exercise")!);
    const cat = exercise.fields.find((f) => f.type === "category");
    expect(cat).toBeDefined();
    expect(cat!.key).toBe("category");
    expect(cat!.options).toEqual(["walk", "run", "bike", "PT", "lift", "yoga", "other"]);
  });

  it("maps hasIntensity → a rating field keyed 'intensity', hasNotes → a text field keyed 'notes'", () => {
    const exercise = backfillTrackable(TRACKABLES.find((t) => t.id === "exercise")!);
    expect(exercise.fields.find((f) => f.key === "intensity")).toMatchObject({ type: "rating", scale: 5 });

    const sleep = backfillTrackable(TRACKABLES.find((t) => t.id === "sleep")!);
    expect(sleep.fields.find((f) => f.key === "notes")).toMatchObject({ type: "text" });
  });

  it("converts presets → pinned single-primary-entry payloads", () => {
    const edibles = backfillTrackable(TRACKABLES.find((t) => t.id === "edibles")!);
    expect(edibles.pinned).toHaveLength(3);
    expect(edibles.pinned![1]).toEqual({
      label: "5mg",
      entries: [{ name: "dose", type: "number", value: 5, unit: "mg" }],
    });

    const sleep = backfillTrackable(TRACKABLES.find((t) => t.id === "sleep")!);
    expect(sleep.pinned).toHaveLength(3);
    expect(sleep.pinned![1]).toEqual({
      label: "8h",
      entries: [{ name: "duration", type: "number", value: 480, unit: "min" }],
    });
  });
});

describe("PB migration embedded JSON stays in sync with the TS backfill", () => {
  it("the migration's life-backfill-manifest.json equals backfillManifest()", () => {
    expect(migrationManifest).toEqual(backfillManifest());
  });
});
