/**
 * Unit tests for wrapPocketBase using a stub PocketBase.
 *
 * Verifies the optimistic semantics in isolation — no real network, no
 * EventSource dependency.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel, RecordSubscription, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase, WrappedPbError } from "./index";
import { clearAllMutations } from "./persistence";

type RealtimeCb = (e: { action: string; record: RecordModel }) => void;

interface StubCollection {
  records: Map<string, RecordModel>;
  realtimeCbs: Set<RealtimeCb>;
  /** Lets a test reject the next operation. */
  rejectNext: { create?: unknown; update?: unknown; delete?: unknown };
}

function makeStubPb(): { pb: PocketBase; emit: (col: string, e: { action: string; record: RecordModel }) => void; col: (n: string) => StubCollection } {
  const cols = new Map<string, StubCollection>();
  const get = (n: string): StubCollection => {
    let c = cols.get(n);
    if (!c) {
      c = { records: new Map(), realtimeCbs: new Set(), rejectNext: {} };
      cols.set(n, c);
    }
    return c;
  };

  const stub = {
    collection: (name: string) => {
      const c = get(name);
      return {
        async create(body: Record<string, unknown>): Promise<RecordModel> {
          if (c.rejectNext.create !== undefined) {
            const err = c.rejectNext.create;
            c.rejectNext.create = undefined;
            throw err;
          }
          const id = (body.id as string) ?? `id-${Math.random().toString(36).slice(2, 17)}`;
          const now = new Date().toISOString();
          const record: RecordModel = {
            id,
            collectionId: name,
            collectionName: name,
            created: now,
            updated: now,
            ...body,
          } as unknown as RecordModel;
          c.records.set(id, record);
          return record;
        },
        async update(id: string, body: Record<string, unknown>): Promise<RecordModel> {
          if (c.rejectNext.update !== undefined) {
            const err = c.rejectNext.update;
            c.rejectNext.update = undefined;
            throw err;
          }
          const existing = c.records.get(id) ?? ({ id } as unknown as RecordModel);
          const updated = { ...existing, ...body, updated: new Date().toISOString() } as RecordModel;
          c.records.set(id, updated);
          return updated;
        },
        async delete(id: string): Promise<boolean> {
          if (c.rejectNext.delete !== undefined) {
            const err = c.rejectNext.delete;
            c.rejectNext.delete = undefined;
            throw err;
          }
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
        // Returns all records in the collection. The stub ignores the filter
        // string — tests that need filtered initial-load behavior should pre-
        // populate `c.records` with only the records they want returned.
        async getFullList(_opts?: unknown): Promise<RecordModel[]> {
          return Array.from(c.records.values());
        },
      };
    },
  } as unknown as PocketBase;

  return {
    pb: stub,
    emit(col: string, e) {
      const c = get(col);
      for (const cb of c.realtimeCbs) cb(e);
    },
    col: get,
  };
}

beforeEach(async () => {
  await clearAllMutations();
});

describe("wrapPocketBase optimistic create", () => {
  it("subscriber receives optimistic create synchronously, before server ack", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const events: Array<{ action: string; id: string }> = [];
    await wpb.collection("items").subscribe("*", (e) => events.push({ action: e.action, id: e.record.id }));

    const ack = wpb.collection("items").create({ id: "a", name: "x" });
    // Already received before await
    expect(events).toContainEqual({ action: "create", id: "a" });

    await ack;
    // After ack, an "update" emission with the server-confirmed record may follow.
    // (Stub returns the same record so it's effectively idempotent.)
  });

  it("predicate filters optimistic creates by collection-level criteria", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const events: string[] = [];
    await wpb.collection("items").subscribe(
      "*",
      (e) => events.push(e.record.id),
      { local: (r) => r.list === "L1" },
    );

    await Promise.all([
      wpb.collection("items").create({ id: "a", list: "L1" }),
      wpb.collection("items").create({ id: "b", list: "L2" }),
    ]);

    expect(events).toContain("a");
    expect(events).not.toContain("b");
  });
});

describe("wrapPocketBase optimistic update", () => {
  it("merges patch onto server snapshot for subscribers", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    // Seed a record server-side and let realtime emit it.
    const seedRecord: RecordModel = { id: "a", name: "old", note: "n", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.col("items").records.set("a", seedRecord);

    let lastSeen: RecordModel | null = null;
    await wpb.collection("items").subscribe("a", (e) => { lastSeen = e.record; });
    // Simulate PB realtime delivering current state.
    stub.emit("items", { action: "update", record: seedRecord });
    expect(lastSeen).toEqual(seedRecord);

    // Optimistic patch.
    const ack = wpb.collection("items").update("a", { name: "new" });
    expect((lastSeen as unknown as RecordModel).name).toBe("new");
    expect((lastSeen as unknown as RecordModel).note).toBe("n");

    await ack;
  });
});

describe("wrapPocketBase optimistic delete", () => {
  it("subscribers see delete event immediately", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seedRecord: RecordModel = { id: "a", list: "L1", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.col("items").records.set("a", seedRecord);

    const events: Array<{ action: string; id: string }> = [];
    await wpb.collection("items").subscribe("*", (e) => events.push({ action: e.action, id: e.record.id }));
    stub.emit("items", { action: "create", record: seedRecord });

    const ack = wpb.collection("items").delete("a");
    expect(events.some((e) => e.action === "delete" && e.id === "a")).toBe(true);

    await ack;
  });
});

describe("wrapPocketBase rejection", () => {
  it("rejected create drops mutation and emits delete to roll back", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const events: Array<{ action: string; id: string }> = [];
    await wpb.collection("items").subscribe("*", (e) => events.push({ action: e.action, id: e.record.id }));

    stub.col("items").rejectNext.create = Object.assign(new Error("forbidden"), { status: 403 });

    let caught: unknown = null;
    try {
      await wpb.collection("items").create({ id: "a", list: "L1" });
    } catch (err) {
      caught = err;
    }

    // Wrapped error carries op metadata so a global handler can toast.
    expect(caught).toBeInstanceOf(WrappedPbError);
    const wrapped = caught as WrappedPbError;
    expect(wrapped.op).toEqual({ kind: "create", collection: "items", recordId: "a" });
    expect((wrapped.originalError as { status?: number }).status).toBe(403);

    const itemEvents = events.filter((e) => e.id === "a");
    expect(itemEvents.length).toBeGreaterThanOrEqual(2);
    expect(itemEvents[0].action).toBe("create");
    expect(itemEvents[itemEvents.length - 1].action).toBe("delete");
  });

  it("rejected update drops mutation and emits prior-server view", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seedRecord = { id: "a", name: "server", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.col("items").records.set("a", seedRecord);

    const seen: Array<RecordModel> = [];
    await wpb.collection("items").subscribe("a", (e) => seen.push(e.record));
    stub.emit("items", { action: "update", record: seedRecord });

    stub.col("items").rejectNext.update = Object.assign(new Error("forbidden"), { status: 403 });

    let rejected = false;
    try {
      await wpb.collection("items").update("a", { name: "optimistic" });
    } catch {
      rejected = true;
    }

    expect(rejected).toBe(true);
    // Last view should be the prior server snapshot (rollback).
    expect(seen[seen.length - 1].name).toBe("server");
  });
});

describe("wrapPocketBase server events", () => {
  it("foreign server update flows through to subscribers", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    let seen: RecordModel | null = null;
    await wpb.collection("items").subscribe("a", (e) => { seen = e.record; });

    const newRecord = { id: "a", name: "from-server", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.emit("items", { action: "create", record: newRecord });

    expect(seen).toEqual(newRecord);
  });

  it("server event for a record with optimistic patch keeps the patch on top", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    let seen: RecordModel | null = null;
    await wpb.collection("items").subscribe("a", (e) => { seen = e.record; });

    // Optimistic update first
    const ack = wpb.collection("items").update("a", { name: "optimistic" });
    expect((seen as RecordModel | null)?.name).toBe(undefined); // no server yet, update on null is no-op

    // Now server delivers a snapshot
    stub.emit("items", { action: "create", record: { id: "a", name: "server", note: "x", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel });
    // View should be the patch on top of server
    expect((seen as unknown as RecordModel).name).toBe("optimistic");
    expect((seen as unknown as RecordModel).note).toBe("x");

    await ack;
  });
});

describe("wrapPocketBase auto-load on subscribe", () => {
  it("subscribe('*', { filter }) loads matching records, seeds the queue, and delivers them as create events before live updates", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    // Seed a record server-side. No SSE event yet — the queue is empty.
    const seed: RecordModel = { id: "a", list: "L1", name: "x", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.col("items").records.set("a", seed);

    const events: Array<{ action: string; record: RecordModel }> = [];
    await wpb.collection("items").subscribe(
      "*",
      (e) => events.push({ action: e.action, record: e.record }),
      { filter: "list = 'L1'", local: (r) => r.list === "L1" },
    );

    // Initial create event delivered before subscribe resolved.
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("create");
    expect(events[0].record.id).toBe("a");
  });

  it("optimistic delete on an auto-loaded record emits the full prior record (not bare {id})", async () => {
    // Repro of the mobile shopping bug: without auto-load seeding the queue,
    // wpb.delete emits notifySubscribers(delete, {id}) and any predicate that
    // reads other fields (like `r.list === listId`) drops the event, so the
    // local subscriber never sees its own delete until SSE confirms.
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seed: RecordModel = { id: "a", list: "L1", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.col("items").records.set("a", seed);

    const events: Array<{ action: string; record: RecordModel }> = [];
    await wpb.collection("items").subscribe(
      "*",
      (e) => events.push({ action: e.action, record: e.record }),
      { filter: "list = 'L1'", local: (r) => r.list === "L1" },
    );

    events.length = 0;

    await wpb.collection("items").delete("a");
    const deleteEvent = events.find((e) => e.action === "delete");
    expect(deleteEvent).toBeDefined();
    // Crucial: the record carries `list`, so subscriber predicates pass.
    expect((deleteEvent!.record as RecordModel & { list: string }).list).toBe("L1");
  });

  it("optimistic update on an auto-loaded record emits a composed view (not skipped)", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seed: RecordModel = { id: "a", list: "L1", checked: false, collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.col("items").records.set("a", seed);

    const events: Array<{ action: string; record: RecordModel }> = [];
    await wpb.collection("items").subscribe(
      "*",
      (e) => events.push({ action: e.action, record: e.record }),
      { filter: "list = 'L1'", local: (r) => r.list === "L1" },
    );

    events.length = 0;

    await wpb.collection("items").update("a", { checked: true });
    const updateEvent = events.find((e) => e.action === "update");
    expect(updateEvent).toBeDefined();
    expect((updateEvent!.record as RecordModel & { checked: boolean; list: string }).checked).toBe(true);
    expect((updateEvent!.record as RecordModel & { checked: boolean; list: string }).list).toBe("L1");
  });

  it("subscribe(id) auto-loads the single record via getOne and delivers it as a create", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seed: RecordModel = { id: "a", name: "server", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.col("items").records.set("a", seed);

    let seen: RecordModel | null = null;
    await wpb.collection("items").subscribe("a", (e) => { seen = e.record; });

    expect(seen).not.toBeNull();
    expect((seen as unknown as RecordModel).id).toBe("a");
  });

  it("subscribe(id) on a missing record (404) does not throw and stays armed for future creates", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const events: RecordModel[] = [];
    await wpb.collection("items").subscribe("a", (e) => { events.push(e.record); });
    expect(events).toHaveLength(0);

    const created: RecordModel = { id: "a", name: "later", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.emit("items", { action: "create", record: created });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("a");
  });
});

describe("wrapPocketBase subscribe replay", () => {
  it("late subscriber sees current pending mutations as create events", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    // Fire optimistic create before subscribe.
    const ack = wpb.collection("items").create({ id: "a", list: "L1", name: "x" });

    // Now subscribe; should receive the pending record on registration.
    const events: Array<{ action: string; id: string }> = [];
    await wpb.collection("items").subscribe("*", (e) => events.push({ action: e.action, id: e.record.id }));

    expect(events.some((e) => e.action === "create" && e.id === "a")).toBe(true);

    await ack;
  });
});
