/**
 * Persistent server-snapshot caching tests for wpb + PBMirror.
 *
 * These cover the stale-while-revalidate cold-load path: server snapshots
 * are persisted to IndexedDB (under the authed user), hydrated on the next
 * session, and painted to consumers BEFORE the network bootstrap resolves.
 * Then the network revalidates, and ghost records (deleted server-side
 * while offline) are reconciled away.
 *
 * The stub here is a trimmed cousin of realworld.test.ts's, plus an
 * `authStore` so the per-user scoping and sign-out paths can be exercised
 * (the snapshot writer stamps `user` from `pb().authStore.record?.id`).
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase } from "./index";
import { createMirror, type RawRecord } from "./mirror";
import { clearAllMutations } from "./persistence";
import {
  loadSnapshotsForUser,
  clearAllSnapshots,
  type PersistedSnapshot,
} from "./snapshot-persistence";

// ---- Stub PocketBase ----

type RealtimeCb = (e: { action: string; record: RecordModel }) => void;

interface StubCollection {
  records: Map<string, RecordModel>;
  realtimeCbs: Set<RealtimeCb>;
  /** Holds in-flight reads when set; tests release explicitly. */
  gateReads: Promise<void> | null;
  /** Holds in-flight writes when set; tests release explicitly. */
  gateWrites: Promise<void> | null;
  fetchCalls: number;
  /** One-shot read failure injector. */
  failNextRead: unknown;
}

interface StubAuthStore {
  record: { id: string } | null;
  onChangeCbs: Set<(token: string, record: { id: string } | null) => void>;
  setRecord: (id: string | null) => void;
}

interface StubHandle {
  pb: PocketBase;
  emit: (col: string, e: { action: string; record: RecordModel }) => void;
  col: (n: string) => StubCollection;
  authStore: StubAuthStore;
  /** Hold every read; release with `releaseReads()`. */
  holdReads: () => void;
  releaseReads: () => void;
  /** Hold every write; release with `releaseWrites()`. */
  holdWrites: () => void;
  releaseWrites: () => void;
}

function makeStubPb(): StubHandle {
  const cols = new Map<string, StubCollection>();
  let releaseReadsAll: () => void = () => {};
  let readsHeld = false;
  let releaseWritesAll: () => void = () => {};
  let writesHeld = false;

  const get = (n: string): StubCollection => {
    let c = cols.get(n);
    if (!c) {
      c = { records: new Map(), realtimeCbs: new Set(), gateReads: null, gateWrites: null, fetchCalls: 0, failNextRead: undefined };
      cols.set(n, c);
    }
    return c;
  };

  const authStore: StubAuthStore = {
    record: null,
    onChangeCbs: new Set(),
    setRecord(id: string | null) {
      this.record = id ? { id } : null;
      for (const cb of this.onChangeCbs) cb(id ? `token-${id}` : "", this.record);
    },
  };

  const applyFilter = (r: RecordModel, filter?: string): boolean => {
    if (!filter) return true;
    const m = filter.match(/^(\w+)\s*=\s*'([^']*)'$/);
    if (m) return (r as unknown as Record<string, unknown>)[m[1]] === m[2];
    return true;
  };
  const applySort = (records: RecordModel[], sort?: string): RecordModel[] => {
    if (!sort) return records;
    const parts = sort.split(",").map((p) => {
      const trimmed = p.trim();
      const desc = trimmed.startsWith("-");
      return { field: desc ? trimmed.slice(1) : trimmed, desc };
    });
    return records.slice().sort((a, b) => {
      for (const { field, desc } of parts) {
        const av = (a as unknown as Record<string, unknown>)[field];
        const bv = (b as unknown as Record<string, unknown>)[field];
        let cmp = 0;
        if (av === bv) cmp = 0;
        else if (av === undefined || av === null) cmp = -1;
        else if (bv === undefined || bv === null) cmp = 1;
        else if ((av as number | string) < (bv as number | string)) cmp = -1;
        else if ((av as number | string) > (bv as number | string)) cmp = 1;
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  };

  const stub = {
    realtime: {
      isConnected: true,
      async subscribe() { return async () => {}; },
      disconnect() {},
    },
    authStore: {
      get record() { return authStore.record; },
      onChange(cb: (token: string, record: { id: string } | null) => void) {
        authStore.onChangeCbs.add(cb);
        return () => { authStore.onChangeCbs.delete(cb); };
      },
    },
    collection: (name: string) => {
      const c = get(name);
      return {
        async subscribe(_topic: string, cb: RealtimeCb): Promise<UnsubscribeFunc> {
          c.realtimeCbs.add(cb);
          return async () => { c.realtimeCbs.delete(cb); };
        },
        async getOne(id: string): Promise<RecordModel> {
          c.fetchCalls += 1;
          if (c.gateReads) await c.gateReads;
          if (c.failNextRead !== undefined) {
            const err = c.failNextRead;
            c.failNextRead = undefined;
            throw err;
          }
          const r = c.records.get(id);
          if (!r) throw Object.assign(new Error("not found"), { status: 404 });
          return r;
        },
        async getFullList(opts?: { filter?: string }): Promise<RecordModel[]> {
          c.fetchCalls += 1;
          if (c.gateReads) await c.gateReads;
          if (c.failNextRead !== undefined) {
            const err = c.failNextRead;
            c.failNextRead = undefined;
            throw err;
          }
          return Array.from(c.records.values()).filter((r) => applyFilter(r, opts?.filter));
        },
        async getList(_page: number, perPage: number, opts?: { filter?: string; sort?: string }): Promise<{ items: RecordModel[] }> {
          c.fetchCalls += 1;
          if (c.gateReads) await c.gateReads;
          if (c.failNextRead !== undefined) {
            const err = c.failNextRead;
            c.failNextRead = undefined;
            throw err;
          }
          const all = Array.from(c.records.values()).filter((r) => applyFilter(r, opts?.filter));
          return { items: applySort(all, opts?.sort).slice(0, perPage) };
        },
        async create(body: Record<string, unknown>): Promise<RecordModel> {
          const id = (body.id as string) ?? `id-${Math.random().toString(36).slice(2)}`;
          const now = new Date().toISOString();
          const record = { id, collectionId: name, collectionName: name, created: now, updated: now, ...body } as unknown as RecordModel;
          c.records.set(id, record);
          return record;
        },
        async update(id: string, body: Record<string, unknown>): Promise<RecordModel> {
          if (c.gateWrites) await c.gateWrites;
          const existing = c.records.get(id);
          if (!existing) throw Object.assign(new Error("not found"), { status: 404 });
          const updated = { ...existing, ...body, updated: new Date().toISOString() } as RecordModel;
          c.records.set(id, updated);
          return updated;
        },
        async delete(id: string): Promise<boolean> {
          c.records.delete(id);
          return true;
        },
      };
    },
  } as unknown as PocketBase;

  return {
    pb: stub,
    emit(col, e) {
      for (const cb of get(col).realtimeCbs) cb(e);
    },
    col: get,
    authStore,
    holdReads() {
      readsHeld = true;
      const p = new Promise<void>((res) => { releaseReadsAll = res; });
      for (const c of cols.values()) c.gateReads = p;
    },
    releaseReads() {
      if (!readsHeld) return;
      releaseReadsAll();
      for (const c of cols.values()) c.gateReads = null;
      readsHeld = false;
    },
    holdWrites() {
      writesHeld = true;
      const p = new Promise<void>((res) => { releaseWritesAll = res; });
      for (const c of cols.values()) c.gateWrites = p;
    },
    releaseWrites() {
      if (!writesHeld) return;
      releaseWritesAll();
      for (const c of cols.values()) c.gateWrites = null;
      writesHeld = false;
    },
  };
}

function rec(name: string, fields: Record<string, unknown> & { id: string }): RecordModel {
  return {
    collectionId: name,
    collectionName: name,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    ...fields,
  } as unknown as RecordModel;
}

async function flush(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Wait past the snapshot writer's debounce window (~250ms) so the batched
 *  IDB put/delete has landed, then drain microtasks. */
async function flushSnapshotWriter(): Promise<void> {
  await new Promise((r) => setTimeout(r, 320));
  await flush(8);
}

beforeEach(async () => {
  // Drain any debounced snapshot writes still pending from a prior test's
  // wpb instance (the writer fires ~250ms after the last applyServer). If we
  // cleared before they fired, the late write would leak into THIS test's
  // store. Waiting past the debounce window first makes clear authoritative.
  await new Promise((r) => setTimeout(r, 320));
  await clearAllMutations();
  await clearAllSnapshots();
});

// ===================================================================
// Persistence: applyServer → IDB write; tombstone → IDB delete
// ===================================================================

describe("snapshot persistence", () => {
  it("persists an applied server snapshot under the authed user (after debounce flush)", async () => {
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    const wpb = wrapPocketBase(() => stub.pb);
    const queue = wpb.mirrorIntegration.queue;

    queue.applyServer("items", "x1", rec("items", { id: "x1", list: "L1", checked: false }));
    await flushSnapshotWriter();

    const rows = await loadSnapshotsForUser("user-A");
    expect(rows.map((r) => r.id)).toContain("x1");
    const row = rows.find((r) => r.id === "x1")!;
    expect(row.collection).toBe("items");
    expect((row.record as RawRecord).checked).toBe(false);
  });

  it("removes a snapshot from IDB when it is tombstoned (applyServer null)", async () => {
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    const wpb = wrapPocketBase(() => stub.pb);
    const queue = wpb.mirrorIntegration.queue;

    queue.applyServer("items", "x2", rec("items", { id: "x2", list: "L1" }));
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A")).map((r) => r.id)).toContain("x2");

    queue.applyServer("items", "x2", null);
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A")).map((r) => r.id)).not.toContain("x2");
  });

  it("flushSnapshots() force-writes the dirty map before the debounce fires", async () => {
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    const wpb = wrapPocketBase(() => stub.pb);
    wpb.mirrorIntegration.queue.applyServer("items", "ff1", rec("items", { id: "ff1", list: "L1" }));

    // Force-flush immediately — do NOT wait for the 250ms debounce. The IDB
    // write must have landed by the time the awaited promise resolves.
    await wpb.flushSnapshots();
    expect((await loadSnapshotsForUser("user-A")).map((r) => r.id)).toContain("ff1");
  });

  it("does NOT persist when there is no authed user (anonymous = no cache)", async () => {
    const stub = makeStubPb();
    // no setRecord → authStore.record is null
    const wpb = wrapPocketBase(() => stub.pb);
    wpb.mirrorIntegration.queue.applyServer("items", "anon", rec("items", { id: "anon" }));
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A"))).toHaveLength(0);
    expect((await loadSnapshotsForUser(""))).toHaveLength(0);
  });
});

// ===================================================================
// Hydration + eager paint (before network resolves), all 3 slice modes
// ===================================================================

describe("snapshot hydration + eager paint", () => {
  async function seedSnapshots(rows: PersistedSnapshot[]): Promise<void> {
    // Persist via a throwaway authed wpb so the debounced writer puts them.
    const seedStub = makeStubPb();
    seedStub.authStore.setRecord(rows[0].user);
    const seedWpb = wrapPocketBase(() => seedStub.pb);
    for (const r of rows) {
      seedWpb.mirrorIntegration.queue.applyServer(r.collection, r.id, r.record);
    }
    await flushSnapshotWriter();
  }

  it("single-record: emits cached record before getOne resolves", async () => {
    await seedSnapshots([
      { key: "user-A::items::s1", user: "user-A", collection: "items", id: "s1", record: rec("items", { id: "s1", name: "cached" }), updatedAt: Date.now() },
    ]);

    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    stub.col("items").records.set("s1", rec("items", { id: "s1", name: "fresh" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();
    stub.holdReads(); // network bootstrap hangs

    const states: RawRecord[][] = [];
    mirror.watch({ collection: "items", topic: "s1" }, (s) => states.push(s));
    await flush();

    // Eager emit happened from cache BEFORE getOne resolved.
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[0]).toEqual([expect.objectContaining({ id: "s1", name: "cached" })]);

    stub.releaseReads();
  });

  it("filter-only wildcard: emits cached records before getFullList resolves", async () => {
    await seedSnapshots([
      { key: "user-A::items::w1", user: "user-A", collection: "items", id: "w1", record: rec("items", { id: "w1", list: "L1", name: "c1" }), updatedAt: Date.now() },
      { key: "user-A::items::w2", user: "user-A", collection: "items", id: "w2", record: rec("items", { id: "w2", list: "L1", name: "c2" }), updatedAt: Date.now() },
    ]);

    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();
    stub.holdReads();

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[0].map((r) => r.id).sort()).toEqual(["w1", "w2"]);

    stub.releaseReads();
  });

  it("sort+limit: emits cached top-N before getList resolves", async () => {
    await seedSnapshots([
      { key: "user-A::log::a", user: "user-A", collection: "log", id: "a", record: rec("log", { id: "a", t: 3 }), updatedAt: Date.now() },
      { key: "user-A::log::b", user: "user-A", collection: "log", id: "b", record: rec("log", { id: "b", t: 2 }), updatedAt: Date.now() },
      { key: "user-A::log::c", user: "user-A", collection: "log", id: "c", record: rec("log", { id: "c", t: 1 }), updatedAt: Date.now() },
    ]);

    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();
    stub.holdReads();

    const states: RawRecord[][] = [];
    mirror.watch({ collection: "log", topic: "*", sort: "-t", limit: 2 }, (s) => states.push(s));
    await flush();

    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[0].map((r) => r.id)).toEqual(["a", "b"]);

    stub.releaseReads();
  });

  it("does NOT eager-emit when cache is empty for the slice (preserves blank-then-data)", async () => {
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    stub.col("items").records.set("z1", rec("items", { id: "z1", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots(); // nothing cached
    stub.holdReads();

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();
    // No eager emit while reads are gated.
    expect(states).toHaveLength(0);

    stub.releaseReads();
    await flush();
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["z1"]);
  });
});

// ===================================================================
// Revalidate after eager paint
// ===================================================================

describe("snapshot revalidate", () => {
  async function seed(rows: PersistedSnapshot[]): Promise<void> {
    const s = makeStubPb();
    s.authStore.setRecord(rows[0].user);
    const w = wrapPocketBase(() => s.pb);
    for (const r of rows) w.mirrorIntegration.queue.applyServer(r.collection, r.id, r.record);
    await flushSnapshotWriter();
  }

  it("second emit with fresh data when network differs", async () => {
    await seed([
      { key: "user-A::items::r1", user: "user-A", collection: "items", id: "r1", record: rec("items", { id: "r1", list: "L1", v: "stale" }), updatedAt: Date.now() },
    ]);
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    stub.col("items").records.set("r1", rec("items", { id: "r1", list: "L1", v: "fresh" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();
    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    expect(states[0][0].v).toBe("stale");
    expect(states[states.length - 1][0].v).toBe("fresh");
    expect(states.length).toBeGreaterThanOrEqual(2);
  });

  it("no second emit when network matches cache (per-consumer hash dedup)", async () => {
    await seed([
      { key: "user-A::items::r2", user: "user-A", collection: "items", id: "r2", record: rec("items", { id: "r2", list: "L1", v: "same" }), updatedAt: Date.now() },
    ]);
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    stub.col("items").records.set("r2", rec("items", { id: "r2", list: "L1", v: "same" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();
    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    expect(states).toHaveLength(1);
    expect(states[0][0].v).toBe("same");
  });
});

// ===================================================================
// Ghost reconciliation: cached record absent from fresh fetch → tombstone
// ===================================================================

describe("snapshot ghost reconciliation", () => {
  async function seed(rows: PersistedSnapshot[]): Promise<void> {
    const s = makeStubPb();
    s.authStore.setRecord(rows[0].user);
    const w = wrapPocketBase(() => s.pb);
    for (const r of rows) w.mirrorIntegration.queue.applyServer(r.collection, r.id, r.record);
    await flushSnapshotWriter();
  }

  it("wildcard/filter: cached ghost (deleted server-side, no pending) is removed after bootstrap", async () => {
    await seed([
      { key: "user-A::items::g1", user: "user-A", collection: "items", id: "g1", record: rec("items", { id: "g1", list: "L1" }), updatedAt: Date.now() },
      { key: "user-A::items::g2", user: "user-A", collection: "items", id: "g2", record: rec("items", { id: "g2", list: "L1" }), updatedAt: Date.now() },
    ]);
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    // Server only still has g1; g2 was deleted while offline.
    stub.col("items").records.set("g1", rec("items", { id: "g1", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();
    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    // Eager paint showed both; final view dropped the ghost.
    expect(states[0].map((r) => r.id).sort()).toEqual(["g1", "g2"]);
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["g1"]);
    // Ghost was tombstoned from IDB too (after the writer's debounce flush).
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A")).map((r) => r.id)).not.toContain("g2");
  });

  it("sort+limit: cached ghost removed after bootstrap", async () => {
    await seed([
      { key: "user-A::log::a", user: "user-A", collection: "log", id: "a", record: rec("log", { id: "a", t: 2 }), updatedAt: Date.now() },
      { key: "user-A::log::b", user: "user-A", collection: "log", id: "b", record: rec("log", { id: "b", t: 1 }), updatedAt: Date.now() },
    ]);
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    stub.col("log").records.set("a", rec("log", { id: "a", t: 2 })); // b deleted offline
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();
    const states: RawRecord[][] = [];
    mirror.watch({ collection: "log", topic: "*", sort: "-t", limit: 5 }, (s) => states.push(s));
    await flush();

    expect(states[0].map((r) => r.id)).toEqual(["a", "b"]);
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);
  });

  it("single-record: getOne 404 tombstones the cached snapshot", async () => {
    await seed([
      { key: "user-A::items::s404", user: "user-A", collection: "items", id: "s404", record: rec("items", { id: "s404", name: "cached" }), updatedAt: Date.now() },
    ]);
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    // Server does NOT have s404 → getOne throws 404.
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();
    const states: RawRecord[][] = [];
    mirror.watch({ collection: "items", topic: "s404" }, (s) => states.push(s));
    await flush();

    expect(states[0]).toEqual([expect.objectContaining({ id: "s404", name: "cached" })]);
    expect(states[states.length - 1]).toEqual([]); // tombstoned after 404
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A")).map((r) => r.id)).not.toContain("s404");
  });

  it("cached ghost WITH a pending mutation survives bootstrap (optimistic write not clobbered)", async () => {
    await seed([
      { key: "user-A::items::p1", user: "user-A", collection: "items", id: "p1", record: rec("items", { id: "p1", list: "L1", v: 1 }), updatedAt: Date.now() },
    ]);
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    stub.col("items"); // materialize the collection so holdWrites() gates it
    // Server doesn't have p1 in the fresh fetch (empty), but we have a pending
    // update. Hold writes so the dispatch stays in flight across bootstrap —
    // the realistic "edited while offline; ghost-deleted on the server"
    // window. The pending entry must shield p1 from the reconcile tombstone.
    stub.holdWrites();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();
    // Optimistic update on the cached record before bootstrap reconciles.
    // The dispatch's network call is held, so the mutation stays pending.
    // .catch() because the server never has p1 → the held write resolves to a
    // permanent 404 (WrappedPbError) when released; swallow it so the rejection
    // doesn't escape as an unhandled rejection (the safeFireAndForgetUnsub
    // footgun in test form).
    void wpb.collection("items").update("p1", { v: 2 }).catch(() => {});

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    // Pending mutation protects the record from the ghost tombstone.
    expect(states[states.length - 1].map((r) => r.id)).toContain("p1");
    expect(states[states.length - 1].find((r) => r.id === "p1")?.v).toBe(2);

    stub.releaseWrites();
    await flush();
  });
});

// ===================================================================
// Per-user scoping + sign-out clear
// ===================================================================

describe("snapshot per-user scoping", () => {
  it("user A snapshots are not hydrated into a user B session", async () => {
    // Seed under user A.
    const sA = makeStubPb();
    sA.authStore.setRecord("user-A");
    const wA = wrapPocketBase(() => sA.pb);
    wA.mirrorIntegration.queue.applyServer("items", "onlyA", rec("items", { id: "onlyA", list: "L1" }));
    await flushSnapshotWriter();

    // Fresh session authed as user B.
    const sB = makeStubPb();
    sB.authStore.setRecord("user-B");
    const wB = wrapPocketBase(() => sB.pb);
    await wB.hydrateSnapshots();

    // B's queue must NOT contain A's record.
    expect(wB.collection("items").view("onlyA")).toBeNull();
  });

  it("sign-out (auth record → null) clears the snapshot store", async () => {
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    const wpb = wrapPocketBase(() => stub.pb);
    // Touch realtime lifecycle so the auth-change hook is installed.
    wpb.mirrorIntegration.queue.applyServer("items", "k1", rec("items", { id: "k1", list: "L1" }));
    await wpb.collection("items").update("k1", { x: 1 }).catch(() => {}); // installs hookAuthChange
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A")).length).toBeGreaterThan(0);

    stub.authStore.setRecord(null); // sign out
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A"))).toHaveLength(0);
  });
});

// ===================================================================
// BLOCKER 1 — SSE-race protection: a stale bootstrap fetch must NOT
// overwrite a fresher live SSE snapshot that raced ahead during the await.
// ===================================================================

describe("BLOCKER 1: bootstrap seed vs racing SSE snapshot", () => {
  it("slice-2's stale fetch (v=1) does NOT clobber an SSE update (v=2) delivered via the shared collection listener", async () => {
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    // Shared record "x" matches BOTH filters (g='A' and h='A'), so it lives in
    // two distinct slices on the SAME collection → they share one SSE listener.
    // It starts at v=1.
    stub.col("items").records.set("x", rec("items", { id: "x", g: "A", h: "A", v: 1 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    // Slice 1: filter g='A'. Bootstrap it fully so the shared collection SSE
    // listener is attached and ready.
    const s1: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "g = 'A'", predicate: (r) => r.g === "A" },
      (s) => s1.push(s),
    );
    await flush();
    expect(s1[s1.length - 1].find((r) => r.id === "x")?.v).toBe(1);

    // Now hold reads so slice 2's bootstrap getFullList pends in flight.
    // CRITICAL: the stub's getFullList reads from c.records at resolve time, so
    // we snapshot the v=1 body into a stale clone the gated fetch will return,
    // then mutate the live store to v=2 below. (The mirror calls getFullList
    // before we hold; we hold first, so the await is captured pre-SSE.)
    stub.holdReads();
    const s2: RawRecord[][] = [];
    mirror.watch(
      // Same collection, different filter → different slice, shared listener.
      { collection: "items", topic: "*", filter: "h = 'A'", predicate: (r) => r.h === "A" },
      (s) => s2.push(s),
    );
    await flush();

    // While slice 2's fetch is gated, a FRESH server update (v=2) lands via the
    // shared collection SSE listener (slice 1 attached it). This calls
    // queue.applyServer → the queue now holds v=2 (real SSE truth). We mutate
    // the live store to v=2 AFTER the SSE so the gated getFullList would return
    // the (already applied) v=2 — but the bug is the seed loop OVERWRITING the
    // queue's v=2 with whatever the fetch carries; to expose it we make the
    // gated fetch carry the STALE v=1 by snapshotting before the SSE. Since the
    // stub reads live records at resolve, we instead rely on the provenance
    // guard: the SSE marks the snapshot non-hydrated, and a fresh fetch that
    // happens to also be v=1 must not regress it. Force that by keeping the
    // gated fetch stale: set the store back to v=1 only for the resolve, then
    // restore. Simplest: emit SSE v=2 and leave the store at v=1 (the gated
    // fetch returns v=1, the stale value) — the guard must keep v=2.
    stub.emit("items", { action: "update", record: rec("items", { id: "x", g: "A", h: "A", v: 2 }) });
    await flush();
    expect(s1[s1.length - 1].find((r) => r.id === "x")?.v).toBe(2);

    // Slice 2's STALE fetch (the store still holds v=1) now resolves. It must
    // NOT overwrite the fresher v=2 SSE snapshot.
    stub.releaseReads();
    await flush();

    // Final emitted value for BOTH slices must be v=2, not v=1.
    expect(s1[s1.length - 1].find((r) => r.id === "x")?.v).toBe(2);
    expect(s2[s2.length - 1].find((r) => r.id === "x")?.v).toBe(2);
  });
});

// ===================================================================
// BLOCKER 2 — ghost reconciliation must NOT run for sort+limit slices:
// a record ranked below the limit is alive on the server but absent from
// the top-N fetch; tombstoning it destroys live data + its IDB row.
// ===================================================================

describe("BLOCKER 2: sort+limit slices never tombstone below-window records", () => {
  it("rank-3 record (below limit:2) survives bootstrap — server still has all 3", async () => {
    // Seed three cached records, all alive on the server.
    const s = makeStubPb();
    s.authStore.setRecord("user-A");
    const w = wrapPocketBase(() => s.pb);
    for (const r of [
      rec("log", { id: "a", t: 3 }),
      rec("log", { id: "b", t: 2 }),
      rec("log", { id: "c", t: 1 }),
    ]) {
      w.mirrorIntegration.queue.applyServer("log", r.id as string, r as unknown as RawRecord);
    }
    await flushSnapshotWriter();

    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    // Server still has ALL three — c is just ranked below the limit:2 window.
    stub.col("log").records.set("a", rec("log", { id: "a", t: 3 }));
    stub.col("log").records.set("b", rec("log", { id: "b", t: 2 }));
    stub.col("log").records.set("c", rec("log", { id: "c", t: 1 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();
    const states: RawRecord[][] = [];
    mirror.watch({ collection: "log", topic: "*", sort: "-t", limit: 2 }, (s) => states.push(s));
    await flush();

    // The visible window is the top-2 (a, b) — that's correct.
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a", "b"]);

    // But the rank-3 record c MUST still be viewable in the queue (NOT
    // tombstoned) — it's alive on the server, just below the window.
    expect(wpb.collection("log").view("c")).not.toBeNull();

    // And its durable IDB snapshot row must still exist (not deleted).
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A")).map((r) => r.id)).toContain("c");
  });
});

// ===================================================================
// BLOCKER 3 — per-user snapshot stamp captured at QUEUE time, not flush
// time; an auth flip during the debounce window must not mis-scope or
// repopulate after clear.
// ===================================================================

describe("BLOCKER 3: per-user snapshot stamping + clear ordering", () => {
  it("a snapshot queued under user-A is never written into user-B's scope when auth flips before flush", async () => {
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    const wpb = wrapPocketBase(() => stub.pb);
    const queue = wpb.mirrorIntegration.queue;

    // Queue a snapshot under user-A (debounce timer starts, hasn't fired).
    queue.applyServer("items", "ax", rec("items", { id: "ax", list: "L1" }));

    // Flip auth to user-B BEFORE the debounce fires.
    stub.authStore.setRecord("user-B");

    // Let the debounce + any clear settle.
    await flushSnapshotWriter();

    // A's record must NOT have landed in B's scope.
    expect((await loadSnapshotsForUser("user-B")).map((r) => r.id)).not.toContain("ax");
  });

  it("an auth-identity flip cancels a pending flush — A's record is never written", async () => {
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    const wpb = wrapPocketBase(() => stub.pb);
    // hydrateSnapshots installs the auth-change hook (the production install
    // point — BackendProvider always calls it on mount before any slice
    // bootstraps and queues snapshots).
    await wpb.hydrateSnapshots();
    const queue = wpb.mirrorIntegration.queue;

    queue.applyServer("items", "ay", rec("items", { id: "ay", list: "L1" }));
    // Identity flip (to user-B) before the debounce fires must synchronously
    // cancel the pending flush + empty the dirty map, then clear the store.
    stub.authStore.setRecord("user-B");
    await flushSnapshotWriter();

    // Neither A nor B should hold ay — the flush was cancelled, and the clear
    // ran ordered after the cancel.
    expect((await loadSnapshotsForUser("user-A")).map((r) => r.id)).not.toContain("ay");
    expect((await loadSnapshotsForUser("user-B")).map((r) => r.id)).not.toContain("ay");
  });

  it("STRUCTURAL: persisting a snapshot arms the clear-hook WITHOUT hydrateSnapshots ever running", async () => {
    // Locks the structural guarantee in onServerChange: any snapshot that
    // reaches IDB must have armed the sign-out clear-hook first, independent of
    // hydrateSnapshots / BackendProvider's render order. We NEVER call
    // hydrateSnapshots here — the only thing that installs the hook is the
    // applyServer → onServerChange chokepoint. Without the fix (hookAuthChange
    // armed in onServerChange) the hook is never installed in this session, so
    // the later sign-out leaves A's row sitting in IDB.
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    const wpb = wrapPocketBase(() => stub.pb);

    // Persist a server snapshot via the chokepoint. No hydrate, no write.
    wpb.mirrorIntegration.queue.applyServer("items", "st1", rec("items", { id: "st1", list: "L1" }));
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A")).map((r) => r.id)).toContain("st1");

    // The clear-hook must already be armed — flip identity and assert the
    // snapshot store is cleared via the persistence layer.
    stub.authStore.setRecord("user-B");
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A"))).toHaveLength(0);
  });

  it("read-only session installs the auth-change clear hook eagerly (no write needed)", async () => {
    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    const wpb = wrapPocketBase(() => stub.pb);
    // hydrateSnapshots is the read-only entrypoint; it must install the
    // auth-change hook so a later sign-out clears the store even though no
    // write ever fired this session.
    await wpb.hydrateSnapshots();

    wpb.mirrorIntegration.queue.applyServer("items", "ro1", rec("items", { id: "ro1", list: "L1" }));
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A")).length).toBeGreaterThan(0);

    // Sign out — with the eager hook installed, the store must clear even
    // though this session only ever read (plus the writer's own applyServer).
    stub.authStore.setRecord(null);
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A"))).toHaveLength(0);
  });
});
