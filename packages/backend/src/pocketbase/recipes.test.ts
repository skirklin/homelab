/**
 * PocketBaseRecipesBackend tests — unit-level, against a stub PocketBase.
 *
 * Covers the recipe-snapshot feature on cooking-log entries:
 *   - addCookingLogEvent snapshots recipe.data at write time
 *   - updateCookingLogEvent does NOT re-snapshot (the snapshot represents
 *     the cook session, not the row's edit history)
 *   - editing the parent recipe afterwards does NOT alter the snapshot on
 *     a previously-written event
 *   - rows with no snapshot (legacy) map to recipeSnapshot=undefined so the
 *     UI can render its disabled-with-tooltip degraded state
 *
 * Same stub-PB pattern as shopping.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase } from "../wrapped-pb";
import { createMirror } from "../wrapped-pb/mirror";
import { clearAllMutations } from "../wrapped-pb/persistence";
import { PocketBaseRecipesBackend } from "./recipes";

type RealtimeCb = (e: { action: string; record: RecordModel }) => void;

interface StubCollection {
  records: Map<string, RecordModel>;
  realtimeCbs: Set<RealtimeCb>;
}

function makeStubPb(): {
  pb: PocketBase;
  col: (n: string) => StubCollection;
} {
  const cols = new Map<string, StubCollection>();
  const get = (n: string): StubCollection => {
    let c = cols.get(n);
    if (!c) {
      c = { records: new Map(), realtimeCbs: new Set() };
      cols.set(n, c);
    }
    return c;
  };

  const stub = {
    filter: (expr: string, params: Record<string, string>) => {
      let out = expr;
      for (const [k, v] of Object.entries(params)) out = out.replace(`{:${k}}`, v);
      return out;
    },
    realtime: {
      onDisconnect: undefined,
      async subscribe(topic: string) {
        if (topic === "PB_CONNECT") return async () => {};
        return async () => {};
      },
    },
    collection: (name: string) => {
      const c = get(name);
      return {
        async create(body: Record<string, unknown>): Promise<RecordModel> {
          const id = (body.id as string) ?? `rand-${Math.random()}`;
          const now = new Date().toISOString();
          const record = { id, collectionId: name, collectionName: name, created: now, updated: now, ...body } as unknown as RecordModel;
          c.records.set(id, record);
          return record;
        },
        async update(id: string, body: Record<string, unknown>): Promise<RecordModel> {
          const existing = c.records.get(id) ?? ({ id } as unknown as RecordModel);
          const updated = { ...existing, ...body, updated: new Date().toISOString() } as RecordModel;
          c.records.set(id, updated);
          return updated;
        },
        async delete(id: string): Promise<boolean> {
          c.records.delete(id);
          return true;
        },
        async subscribe(_topic: string, cb: RealtimeCb): Promise<UnsubscribeFunc> {
          c.realtimeCbs.add(cb);
          return async () => { c.realtimeCbs.delete(cb); };
        },
        async getOne(id: string): Promise<RecordModel> {
          const r = c.records.get(id);
          if (!r) throw Object.assign(new Error("not found"), { status: 404 });
          return r;
        },
        async getFullList(): Promise<RecordModel[]> {
          return Array.from(c.records.values());
        },
        async getList(): Promise<{ items: RecordModel[] }> {
          return { items: Array.from(c.records.values()) };
        },
        async getFirstListItem(): Promise<RecordModel> {
          throw Object.assign(new Error("not found"), { status: 404 });
        },
      };
    },
  } as unknown as PocketBase;

  return { pb: stub, col: get };
}

function seedRecipe(
  stub: ReturnType<typeof makeStubPb>,
  id: string,
  boxId: string,
  data: Record<string, unknown>,
): void {
  stub.col("recipes").records.set(id, {
    id,
    collectionId: "recipes",
    collectionName: "recipes",
    created: "",
    updated: "",
    box: boxId,
    data,
    owners: ["u1"],
    visibility: "private",
    enrichment_status: "needed",
  } as unknown as RecordModel);
}

function drain(): Promise<void> {
  // The wpb optimistic queue flushes via microtasks; six ticks is enough to
  // settle a single mutation in our tests.
  return new Promise<void>(async (resolve) => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    resolve();
  });
}

beforeEach(async () => {
  await clearAllMutations();
});

describe("PocketBaseRecipesBackend — recipe snapshots", () => {
  it("addCookingLogEvent snapshots the recipe.data at write time", async () => {
    const stub = makeStubPb();
    const data = {
      name: "Pancakes",
      recipeIngredient: ["1 cup flour", "1 cup milk", "1 egg"],
      recipeInstructions: [{ "@type": "HowToStep", text: "Mix" }, { "@type": "HowToStep", text: "Cook" }],
    };
    seedRecipe(stub, "R1", "B1", data);

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const recipes = new PocketBaseRecipesBackend(() => stub.pb, wpb, mirror);

    const eventId = await recipes.addCookingLogEvent("B1", "R1", "u1", { notes: "first time" });
    await drain();

    const event = stub.col("recipe_events").records.get(eventId);
    expect(event).toBeDefined();
    expect((event as unknown as Record<string, unknown>).recipe_snapshot).toEqual(data);
  });

  it("updateCookingLogEvent does NOT touch recipe_snapshot", async () => {
    const stub = makeStubPb();
    const originalData = { name: "Pancakes", recipeIngredient: ["1 cup milk"] };
    seedRecipe(stub, "R1", "B1", originalData);

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const recipes = new PocketBaseRecipesBackend(() => stub.pb, wpb, mirror);

    const eventId = await recipes.addCookingLogEvent("B1", "R1", "u1", { notes: "v1" });
    await drain();

    const snapshotBefore = (stub.col("recipe_events").records.get(eventId) as unknown as Record<string, unknown>).recipe_snapshot;
    expect(snapshotBefore).toEqual(originalData);

    await recipes.updateCookingLogEvent(eventId, { notes: "v2" });
    await drain();

    // Snapshot is unchanged; notes are updated.
    const after = stub.col("recipe_events").records.get(eventId) as unknown as Record<string, unknown>;
    expect(after.recipe_snapshot).toEqual(originalData);
    const entries = after.entries as Array<{ name: string; value: string }>;
    expect(entries.find((e) => e.name === "notes")?.value).toBe("v2");
  });

  it("editing the parent recipe afterwards does NOT mutate snapshots on past events", async () => {
    const stub = makeStubPb();
    const originalData = { name: "Pancakes", recipeIngredient: ["3 cup milk"] };
    seedRecipe(stub, "R1", "B1", originalData);

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const recipes = new PocketBaseRecipesBackend(() => stub.pb, wpb, mirror);

    const eventId = await recipes.addCookingLogEvent("B1", "R1", "u1");
    await drain();

    // Now overwrite the recipe (user incorporated their note).
    await recipes.saveRecipe("R1", { name: "Pancakes", recipeIngredient: ["4 cup milk"] }, "u1");
    await drain();

    const ev = stub.col("recipe_events").records.get(eventId) as unknown as Record<string, unknown>;
    expect(ev.recipe_snapshot).toEqual(originalData);
    // …and the live recipe reflects the new milk quantity.
    const live = stub.col("recipes").records.get("R1") as unknown as Record<string, unknown>;
    expect((live.data as Record<string, unknown>).recipeIngredient).toEqual(["4 cup milk"]);
  });

  it("getCookingLogEvents returns recipeSnapshot for new rows and undefined for legacy ones", async () => {
    const stub = makeStubPb();
    seedRecipe(stub, "R1", "B1", { name: "Pancakes", recipeIngredient: ["1 cup milk"] });

    // Legacy event written directly with no recipe_snapshot column.
    stub.col("recipe_events").records.set("legacy", {
      id: "legacy",
      collectionId: "recipe_events",
      collectionName: "recipe_events",
      created: "",
      updated: "",
      box: "B1",
      subject_id: "R1",
      timestamp: new Date("2024-01-01").toISOString(),
      entries: [{ name: "notes", type: "text", value: "old cook" }],
      created_by: "u1",
    } as unknown as RecordModel);

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const recipes = new PocketBaseRecipesBackend(() => stub.pb, wpb, mirror);

    await recipes.addCookingLogEvent("B1", "R1", "u1", { notes: "new cook" });
    await drain();

    const events = await recipes.getCookingLogEvents("B1", "R1");
    expect(events).toHaveLength(2);
    const legacy = events.find((e) => e.id === "legacy");
    const fresh = events.find((e) => e.id !== "legacy");
    expect(legacy?.recipeSnapshot).toBeUndefined();
    expect(fresh?.recipeSnapshot).toEqual({ name: "Pancakes", recipeIngredient: ["1 cup milk"] });
  });

  it("addCookingLogEvent persists with recipeSnapshot null when the recipe is missing rather than throwing", async () => {
    const stub = makeStubPb();
    // Note: NO seedRecipe call — recipe lookup will 404.

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const recipes = new PocketBaseRecipesBackend(() => stub.pb, wpb, mirror);

    const eventId = await recipes.addCookingLogEvent("B1", "missing", "u1", { notes: "logged but recipe gone" });
    await drain();

    const ev = stub.col("recipe_events").records.get(eventId) as unknown as Record<string, unknown>;
    // Snapshot is null (not the recipe's data) — losing the snapshot is
    // preferable to losing the cook event.
    expect(ev.recipe_snapshot).toBeNull();
    const entries = ev.entries as Array<{ name: string; value: string }>;
    expect(entries.find((e) => e.name === "notes")?.value).toBe("logged but recipe gone");
  });
});

describe("PocketBaseRecipesBackend — cooking-log ratings", () => {
  function makeBackend(stub: ReturnType<typeof makeStubPb>) {
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    return new PocketBaseRecipesBackend(() => stub.pb, wpb, mirror);
  }

  it("addCookingLogEvent stores the rating as a number entry and getCookingLogEvents derives it", async () => {
    const stub = makeStubPb();
    seedRecipe(stub, "R1", "B1", { name: "Pancakes" });
    const recipes = makeBackend(stub);

    const eventId = await recipes.addCookingLogEvent("B1", "R1", "u1", { notes: "great", rating: 4 });
    await drain();

    const raw = stub.col("recipe_events").records.get(eventId) as unknown as Record<string, unknown>;
    const entries = raw.entries as Array<Record<string, unknown>>;
    expect(entries).toContainEqual({ name: "rating", type: "number", value: 4, unit: "stars" });
    expect(entries.find((e) => e.name === "notes")?.value).toBe("great");

    const events = await recipes.getCookingLogEvents("B1", "R1");
    expect(events[0].rating).toBe(4);
  });

  it("updateCookingLogEvent patches rating and notes independently; null clears", async () => {
    const stub = makeStubPb();
    seedRecipe(stub, "R1", "B1", { name: "Pancakes" });
    const recipes = makeBackend(stub);

    const eventId = await recipes.addCookingLogEvent("B1", "R1", "u1", { notes: "v1", rating: 2 });
    await drain();

    // Rating-only update preserves notes.
    await recipes.updateCookingLogEvent(eventId, { rating: 5 });
    await drain();
    let raw = stub.col("recipe_events").records.get(eventId) as unknown as Record<string, unknown>;
    let entries = raw.entries as Array<Record<string, unknown>>;
    expect(entries.find((e) => e.name === "rating")?.value).toBe(5);
    expect(entries.find((e) => e.name === "notes")?.value).toBe("v1");

    // Notes-only update preserves rating.
    await recipes.updateCookingLogEvent(eventId, { notes: "v2" });
    await drain();
    raw = stub.col("recipe_events").records.get(eventId) as unknown as Record<string, unknown>;
    entries = raw.entries as Array<Record<string, unknown>>;
    expect(entries.find((e) => e.name === "rating")?.value).toBe(5);
    expect(entries.find((e) => e.name === "notes")?.value).toBe("v2");

    // Null clears the rating entry; notes survive.
    await recipes.updateCookingLogEvent(eventId, { rating: null });
    await drain();
    raw = stub.col("recipe_events").records.get(eventId) as unknown as Record<string, unknown>;
    entries = raw.entries as Array<Record<string, unknown>>;
    expect(entries.find((e) => e.name === "rating")).toBeUndefined();
    expect(entries.find((e) => e.name === "notes")?.value).toBe("v2");
  });

  it("updateCookingLogEvent with an empty patch is a no-op (no read, no write)", async () => {
    const stub = makeStubPb();
    seedRecipe(stub, "R1", "B1", { name: "Pancakes" });
    const recipes = makeBackend(stub);

    const eventId = await recipes.addCookingLogEvent("B1", "R1", "u1", { notes: "v1", rating: 2 });
    await drain();
    const before = stub.col("recipe_events").records.get(eventId);

    await recipes.updateCookingLogEvent(eventId, {});
    await drain();
    // Same object — no write happened (a write would have replaced/bumped it).
    expect(stub.col("recipe_events").records.get(eventId)).toBe(before);

    // The read is skipped too: an empty patch on a nonexistent id resolves
    // instead of failing the getOne.
    await expect(recipes.updateCookingLogEvent("does-not-exist", {})).resolves.toBeUndefined();
  });

  it("rejects invalid ratings before any write", async () => {
    const stub = makeStubPb();
    seedRecipe(stub, "R1", "B1", { name: "Pancakes" });
    const recipes = makeBackend(stub);

    await expect(recipes.addCookingLogEvent("B1", "R1", "u1", { rating: 0 })).rejects.toThrow(/rating/);
    await expect(recipes.addCookingLogEvent("B1", "R1", "u1", { rating: 6 })).rejects.toThrow(/rating/);
    await expect(recipes.addCookingLogEvent("B1", "R1", "u1", { rating: 2.5 })).rejects.toThrow(/rating/);
    expect(stub.col("recipe_events").records.size).toBe(0);

    const eventId = await recipes.addCookingLogEvent("B1", "R1", "u1", { rating: 3 });
    await drain();
    await expect(recipes.updateCookingLogEvent(eventId, { rating: -1 })).rejects.toThrow(/rating/);
  });

  it("legacy rows without a rating entry map to rating undefined", async () => {
    const stub = makeStubPb();
    seedRecipe(stub, "R1", "B1", { name: "Pancakes" });
    stub.col("recipe_events").records.set("legacy", {
      id: "legacy",
      collectionId: "recipe_events",
      collectionName: "recipe_events",
      created: "",
      updated: "",
      box: "B1",
      subject_id: "R1",
      timestamp: new Date("2024-01-01").toISOString(),
      entries: [{ name: "notes", type: "text", value: "old cook" }],
      created_by: "u1",
    } as unknown as RecordModel);
    const recipes = makeBackend(stub);

    const events = await recipes.getCookingLogEvents("B1", "R1");
    expect(events[0].rating).toBeUndefined();
  });
});
