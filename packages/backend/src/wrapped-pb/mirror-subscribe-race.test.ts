/**
 * PBMirror pre-registration race tests.
 *
 * Two intertwined hardening goals, both exercised here:
 *
 *   PART A — overlap + await registration.
 *     bootstrap() must kick off the SSE subscribe() registration CONCURRENTLY
 *     with the initial fetch, and must AWAIT that registration (raced against a
 *     timeout) before marking the slice ready and emitting fresh state. This
 *     closes the "PocketBase does not replay events published before the
 *     subscription is registered server-side" window: an event fired right
 *     after the consumer subscribes is no longer lost.
 *
 *   PART B — pre-ready-window correctness.
 *     Because the live listener now attaches BEFORE the fetch resolves, SSE
 *     events for the collection land in the queue + slice.records DURING the
 *     fetch (the "pre-ready window"). Bootstrap's consolidation (seed loop,
 *     reconcileGhosts, sort+limit slice.records replace) runs AFTER and must
 *     NOT corrupt that live state:
 *       - a pre-ready CREATE must be retained (not tombstoned, not dropped),
 *       - a pre-ready DELETE must stay deleted (not resurrected by the seed),
 *       - a pre-ready UPDATE's live value must win over the staler fetch value,
 *       - a GENUINE ghost (cached, server-deleted, NOT live-touched) must STILL
 *         be reconciled away (no regression of the snapshot-cache ghost fix).
 *
 * The stub here gates SSE registration (the subscribe() Promise) INDEPENDENTLY
 * of reads, so a test can: attach the listener, fire a pre-ready SSE event,
 * then resolve the fetch, then resolve registration — reproducing the real
 * ordering a live PB produces. The realtime callback is invoked the instant
 * the listener is registered locally (which is synchronous in the SDK — only
 * the registration POST is async), so `emit()` reaches the mirror even while
 * the registration Promise is still pending.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase } from "./index";
import { createMirror, type RawRecord } from "./mirror";
import { clearAllMutations } from "./persistence";
import {
  clearAllSnapshots,
  loadSnapshotsForUser,
  type PersistedSnapshot,
} from "./snapshot-persistence";

// ---- Stub PocketBase with independently-gateable SSE registration ----

type RealtimeCb = (e: { action: string; record: RecordModel }) => void;

interface StubCollection {
  records: Map<string, RecordModel>;
  realtimeCbs: Set<RealtimeCb>;
  subscribeCalls: number;
  fetchCalls: number;
  gateReads: Promise<void> | null;
  /** When set, the subscribe() Promise (registration POST) does not resolve
   *  until released — but the callback is ALREADY registered locally, so
   *  emit() reaches the mirror in the pre-ready window. */
  gateRegistration: Promise<void> | null;
  /** When true, subscribe() throws synchronously (no-EventSource path). */
  throwOnSubscribe: boolean;
  /** When true, the subscribe() Promise rejects (after the gate releases). */
  rejectRegistration: boolean;
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
  holdReads: () => void;
  releaseReads: () => void;
  holdRegistration: () => void;
  releaseRegistration: () => void;
}

function makeStubPb(): StubHandle {
  const cols = new Map<string, StubCollection>();
  let releaseReadsAll: () => void = () => {};
  let readsHeld = false;
  let releaseRegAll: () => void = () => {};
  let regHeld = false;

  const get = (n: string): StubCollection => {
    let c = cols.get(n);
    if (!c) {
      c = {
        records: new Map(),
        realtimeCbs: new Set(),
        subscribeCalls: 0,
        fetchCalls: 0,
        gateReads: null,
        gateRegistration: null,
        throwOnSubscribe: false,
        rejectRegistration: false,
      };
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
      // The mirror's reconnect hook subscribes to PB_CONNECT on the realtime
      // surface. Resolve immediately — this test file doesn't exercise resync.
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
          c.subscribeCalls += 1;
          if (c.throwOnSubscribe) {
            // Synchronous throw mirrors "EventSource is not defined" in Node.
            throw new Error("EventSource is not defined");
          }
          // The callback is registered LOCALLY and synchronously by the SDK;
          // only the registration POST is async. So emit() reaches the mirror
          // even while the registration Promise below is still pending — the
          // pre-ready window.
          c.realtimeCbs.add(cb);
          if (c.gateRegistration) await c.gateRegistration;
          if (c.rejectRegistration) {
            c.realtimeCbs.delete(cb);
            throw new Error("registration POST failed");
          }
          return async () => { c.realtimeCbs.delete(cb); };
        },
        async getOne(id: string): Promise<RecordModel> {
          c.fetchCalls += 1;
          if (c.gateReads) await c.gateReads;
          const r = c.records.get(id);
          if (!r) throw Object.assign(new Error("not found"), { status: 404 });
          return r;
        },
        async getFullList(opts?: { filter?: string }): Promise<RecordModel[]> {
          c.fetchCalls += 1;
          if (c.gateReads) await c.gateReads;
          return Array.from(c.records.values()).filter((r) => applyFilter(r, opts?.filter));
        },
        async getList(_page: number, perPage: number, opts?: { filter?: string; sort?: string }): Promise<{ items: RecordModel[] }> {
          c.fetchCalls += 1;
          // Snapshot the result at CALL time (before the gate), mirroring a real
          // query that executes when issued: a gated getList returns the state
          // that existed when the request was made, not whatever the test mutated
          // while the gate was held. This lets a test gate the bootstrap fetch
          // (capturing pre-delete state) and then mutate the server so a later
          // UNGATED refetch sees post-delete state.
          const snapshot = applySort(
            Array.from(c.records.values()).filter((r) => applyFilter(r, opts?.filter)),
            opts?.sort,
          ).slice(0, perPage);
          if (c.gateReads) await c.gateReads;
          return { items: snapshot };
        },
        async create(body: Record<string, unknown>): Promise<RecordModel> {
          const id = (body.id as string) ?? `id-${Math.random().toString(36).slice(2)}`;
          const now = new Date().toISOString();
          const record = { id, collectionId: name, collectionName: name, created: now, updated: now, ...body } as unknown as RecordModel;
          c.records.set(id, record);
          return record;
        },
        async update(id: string, body: Record<string, unknown>): Promise<RecordModel> {
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
    holdRegistration() {
      regHeld = true;
      const p = new Promise<void>((res) => { releaseRegAll = res; });
      for (const c of cols.values()) c.gateRegistration = p;
    },
    releaseRegistration() {
      if (!regHeld) return;
      releaseRegAll();
      for (const c of cols.values()) c.gateRegistration = null;
      regHeld = false;
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

async function flushSnapshotWriter(): Promise<void> {
  await new Promise((r) => setTimeout(r, 320));
  await flush(8);
}

/** Seed durable snapshot rows for a user via a throwaway authed wpb. */
async function seedSnapshots(rows: PersistedSnapshot[]): Promise<void> {
  const seedStub = makeStubPb();
  seedStub.authStore.setRecord(rows[0].user);
  const seedWpb = wrapPocketBase(() => seedStub.pb);
  for (const r of rows) {
    seedWpb.mirrorIntegration.queue.applyServer(r.collection, r.id, r.record);
  }
  await flushSnapshotWriter();
}

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 320));
  await clearAllMutations();
  await clearAllSnapshots();
});

// =====================================================================
// PART A — overlap + await registration
// =====================================================================

describe("PART A: overlap registration with fetch, await before ready", () => {
  it("issues subscribe() CONCURRENTLY with the fetch (overlap, not after)", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    // Gate the fetch so it stays in flight. If subscribe were issued AFTER the
    // fetch resolves (old behavior), subscribeCalls would be 0 here.
    stub.holdReads();
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      () => {},
    );
    await flush();

    expect(
      stub.col("items").subscribeCalls,
      "subscribe must be issued while the fetch is still gated (overlap)",
    ).toBe(1);

    stub.releaseReads();
    await flush();
  });

  it("an event published right after subscribe (pre-ready) is delivered, not lost", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1", v: 1 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    // Hold registration so the slice can't become ready until we release it;
    // fire a create in that window.
    stub.holdRegistration();
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    // The window: listener attached, registration pending. A producer fires a
    // create. On a real PB this event would be DELIVERED (we registered before
    // it was published). The mirror must retain it.
    stub.col("items").records.set("b", rec("items", { id: "b", list: "L1", v: 1 }));
    stub.emit("items", { action: "create", record: rec("items", { id: "b", list: "L1", v: 1 }) });
    await flush();

    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("defers ready + fresh emit until registration resolves", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdRegistration();
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    // Fetch has resolved, but registration is still pending → no fresh emit yet
    // (no cache to eager-paint, so zero emits).
    expect(states, "must not emit fresh state before registration resolves").toHaveLength(0);

    stub.releaseRegistration();
    await flush();
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);
  });

  it("eager paint from cache fires BEFORE registration resolves (no cold-load regression)", async () => {
    await seedSnapshots([
      { key: "user-A::items::c1", user: "user-A", collection: "items", id: "c1", record: rec("items", { id: "c1", list: "L1", name: "cached" }), updatedAt: Date.now() },
    ]);

    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    stub.col("items").records.set("c1", rec("items", { id: "c1", list: "L1", name: "fresh" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();
    // BOTH reads and registration gated. Eager paint must still emit instantly.
    stub.holdReads();
    stub.holdRegistration();

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    expect(states.length, "eager paint must not wait on registration").toBeGreaterThanOrEqual(1);
    expect(states[0]).toEqual([expect.objectContaining({ id: "c1", name: "cached" })]);

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();
  });

  it("timeout fallback: a never-resolving registration still becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const stub = makeStubPb();
      stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
      const wpb = wrapPocketBase(() => stub.pb);
      const mirror = createMirror(() => stub.pb, wpb);

      const states: RawRecord[][] = [];
      stub.holdRegistration(); // never released
      mirror.watch(
        { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
        (s) => states.push(s),
      );
      // Drain the fetch microtasks, then advance past the 10s timeout.
      await vi.advanceTimersByTimeAsync(0);
      expect(states, "not ready before timeout").toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10_001);

      expect(states.length, "timeout fallback makes the slice ready").toBeGreaterThanOrEqual(1);
      expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("teardown during the pre-registration window: no leaked listener, no wasted subscribe", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    stub.holdReads(); // bootstrap pends before the microtask yield
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      () => {},
    );
    // Synchronous teardown before bootstrap's first real await → must not even
    // issue the subscribe (cancel-before-resolve invariant, scenarios 7/9).
    handle.unsubscribe();
    stub.releaseReads();
    await flush();

    expect(stub.col("items").subscribeCalls, "no wasted subscribe on cancel-during-bootstrap").toBe(0);
    expect(stub.col("items").realtimeCbs.size, "no leaked realtime subscriber").toBe(0);
  });

  it("sync subscribe throw (no EventSource) does not hang or throw; slice still ready", async () => {
    const stub = makeStubPb();
    stub.col("items").throwOnSubscribe = true;
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    expect(states.length, "ready despite no EventSource").toBeGreaterThanOrEqual(1);
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);
  });

  it("late registration rejection (after timeout window irrelevant) does not blank the slice", async () => {
    const stub = makeStubPb();
    stub.col("items").rejectRegistration = true;
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    // Registration rejected, but the slice must still become ready and emit.
    expect(states.length, "ready despite registration rejection").toBeGreaterThanOrEqual(1);
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);
  });
});

// =====================================================================
// PART B — pre-ready-window correctness, across all three slice shapes
// =====================================================================
//
// In each test the slice's fetch is gated, the listener is attached (registration
// also gated so the slice can't go ready), a pre-ready SSE event fires, THEN the
// fetch + registration release. The fetch deliberately predates the SSE event,
// so the live SSE value must win.

describe("PART B: pre-ready CREATE retained (not tombstoned / not dropped)", () => {
  it("filter-only wildcard: a create that lands before ready survives bootstrap", async () => {
    const stub = makeStubPb();
    // Server fetch will return ONLY 'a' (the create 'b' lands via SSE after the
    // fetch query ran, so the fetch can't see it).
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    // Pre-ready CREATE 'b' via SSE — NOT in the (already-captured) fetch result.
    stub.emit("items", { action: "create", record: rec("items", { id: "b", list: "L1" }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last.map((r) => r.id).sort(), "pre-ready create must survive (not tombstoned)").toEqual(["a", "b"]);
    // And it must be a live (non-null) view in the queue.
    expect(wpb.collection("items").view("b")).not.toBeNull();
  });

  it("sort+limit: a create that lands before ready is NOT dropped by the slice.records replace", async () => {
    const stub = makeStubPb();
    stub.col("log").records.set("a", rec("log", { id: "a", t: 1 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch({ collection: "log", topic: "*", sort: "-t", limit: 10 }, (s) => states.push(s));
    await flush();

    // Pre-ready CREATE 'b' with higher rank — fetch (gated, captured pre-SSE)
    // returns only 'a'. The sort+limit slice.records replace must retain 'b'.
    stub.emit("log", { action: "create", record: rec("log", { id: "b", t: 5 }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last.map((r) => r.id), "pre-ready create must be merged into the window").toEqual(["b", "a"]);
  });

  it("single-record (topic=id): a create for the watched id before ready survives", async () => {
    const stub = makeStubPb();
    // 'k' does NOT exist on the server at fetch time → getOne 404. It is then
    // created via a pre-ready SSE create.
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdRegistration();
    mirror.watch({ collection: "items", topic: "k" }, (s) => states.push(s));
    await flush();

    stub.emit("items", { action: "create", record: rec("items", { id: "k", name: "born" }) });
    await flush();

    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last, "pre-ready create for the watched id must survive a 404 fetch").toEqual([
      expect.objectContaining({ id: "k", name: "born" }),
    ]);
  });
});

describe("PART B: pre-ready DELETE stays deleted (not resurrected by seed loop)", () => {
  it("filter-only wildcard: a delete before ready is NOT re-seeded by the stale fetch", async () => {
    const stub = makeStubPb();
    // Fetch (gated, captured pre-SSE) still HAS 'a' — the delete races in after.
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    stub.col("items").records.set("b", rec("items", { id: "b", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    // Pre-ready DELETE 'a' via SSE — but the gated fetch STILL carries 'a'.
    stub.emit("items", { action: "delete", record: rec("items", { id: "a", list: "L1" }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last.map((r) => r.id), "pre-ready delete must stay deleted (not resurrected)").toEqual(["b"]);
    expect(wpb.collection("items").view("a"), "queue must reflect the delete").toBeNull();
  });

  it("sort+limit: a delete before ready stays deleted after slice.records replace", async () => {
    const stub = makeStubPb();
    stub.col("log").records.set("a", rec("log", { id: "a", t: 3 }));
    stub.col("log").records.set("b", rec("log", { id: "b", t: 2 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch({ collection: "log", topic: "*", sort: "-t", limit: 10 }, (s) => states.push(s));
    await flush();

    // Pre-ready DELETE 'a' — gated fetch still carries both a and b.
    stub.emit("log", { action: "delete", record: rec("log", { id: "a", t: 3 }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last.map((r) => r.id), "deleted record must not reappear in the window").toEqual(["b"]);
  });

  it("single-record: a delete before ready is not resurrected by a stale getOne hit", async () => {
    const stub = makeStubPb();
    // getOne(k) will SUCCEED (stale) — the record is deleted via SSE after the
    // fetch query ran.
    stub.col("items").records.set("k", rec("items", { id: "k", name: "doomed" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch({ collection: "items", topic: "k" }, (s) => states.push(s));
    await flush();

    stub.emit("items", { action: "delete", record: rec("items", { id: "k" }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last, "pre-ready delete must win over the stale getOne hit").toEqual([]);
    expect(wpb.collection("items").view("k")).toBeNull();
  });
});

describe("PART B: pre-ready UPDATE's live value wins over staler fetch", () => {
  it("filter-only wildcard: SSE v=2 before ready is not regressed to fetch v=1", async () => {
    const stub = makeStubPb();
    // Fetch (gated) carries the STALE v=1.
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1", v: 1 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    stub.emit("items", { action: "update", record: rec("items", { id: "a", list: "L1", v: 2 }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last.find((r) => r.id === "a")?.v, "live SSE update must win over stale fetch").toBe(2);
  });

  it("sort+limit: SSE update before ready survives the slice.records replace", async () => {
    const stub = makeStubPb();
    stub.col("log").records.set("a", rec("log", { id: "a", t: 1, v: 1 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch({ collection: "log", topic: "*", sort: "-t", limit: 10 }, (s) => states.push(s));
    await flush();

    stub.emit("log", { action: "update", record: rec("log", { id: "a", t: 1, v: 2 }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last.find((r) => r.id === "a")?.v, "live SSE update must win for sort+limit").toBe(2);
  });

  it("single-record: SSE update before ready wins over a staler getOne", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("k", rec("items", { id: "k", v: 1 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch({ collection: "items", topic: "k" }, (s) => states.push(s));
    await flush();

    stub.emit("items", { action: "update", record: rec("items", { id: "k", v: 2 }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last[0]?.v, "live SSE update must win for single-record").toBe(2);
  });
});

describe("PART B: genuine ghost STILL reconciled (no regression)", () => {
  it("a cached, server-deleted record NOT touched by a live SSE event is still tombstoned", async () => {
    // Cache holds g1 + g2. Server only still has g1 — g2 was deleted offline.
    // NO SSE event touches g2 during the window, so reconcile must remove it.
    await seedSnapshots([
      { key: "user-A::items::g1", user: "user-A", collection: "items", id: "g1", record: rec("items", { id: "g1", list: "L1", name: "alive" }), updatedAt: Date.now() },
      { key: "user-A::items::g2", user: "user-A", collection: "items", id: "g2", record: rec("items", { id: "g2", list: "L1", name: "ghost" }), updatedAt: Date.now() },
    ]);

    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    stub.col("items").records.set("g1", rec("items", { id: "g1", list: "L1", name: "alive" }));
    // g2 deliberately absent from the server.
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    const last = states[states.length - 1];
    expect(last.map((r) => r.id), "genuine ghost must still be reconciled away").toEqual(["g1"]);
    expect(wpb.collection("items").view("g2"), "ghost tombstoned in queue").toBeNull();

    // And its durable IDB row removed (no regression of the ghost-tombstone fix).
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A")).map((r) => r.id)).not.toContain("g2");
  });

  it("a pre-ready CREATE is NOT tombstoned even though it's absent from the fetch (the discriminator)", async () => {
    // This is the inverse of the genuine-ghost case: the id IS absent from the
    // fetch, but it was touched by a live SSE create during the window, so it
    // must be RETAINED, not tombstoned. Proves the touched-set discriminates.
    const stub = makeStubPb();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    stub.emit("items", { action: "create", record: rec("items", { id: "live", list: "L1" }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    expect(states[states.length - 1].map((r) => r.id).sort()).toEqual(["a", "live"]);
  });
});

// =====================================================================
// REVIEW MATRIX CELL 1 — warm-cache (eager-ready) + live SSE in the window
// =====================================================================
//
// A warm-cache slice eager-paints from the snapshot cache and sets ready=true
// BEFORE the gated fetch resolves. Touched-set population must therefore be
// keyed on `consolidated`, NOT `ready`: an SSE event arriving while the fetch is
// still in flight must still enter sseTouchedDuringBootstrap, or bootstrap's
// consolidation (which runs against a fetch result that predates the event)
// tombstones a pre-fetch create / resurrects a pre-fetch delete. This is the
// Blocker-1 regression on the steady-state path for every returning user.
// These two tests FAIL on the pre-fix code (touched-set keyed on `!ready`).

describe("MATRIX 1: warm-cache eager-ready + live SSE in the gated-fetch window", () => {
  it("a pre-fetch SSE CREATE during a warm-cache (eager-ready) bootstrap is retained, not tombstoned", async () => {
    // Cache holds c1 (server-backed) → eager paint fires + sets ready=true.
    await seedSnapshots([
      { key: "user-A::items::c1", user: "user-A", collection: "items", id: "c1", record: rec("items", { id: "c1", list: "L1", name: "cached" }), updatedAt: Date.now() },
    ]);

    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    // Fetch (gated) will return ONLY c1. The create 'new' lands via SSE after
    // the fetch query was captured, so the fetch can't see it.
    stub.col("items").records.set("c1", rec("items", { id: "c1", list: "L1", name: "cached" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();

    const states: RawRecord[][] = [];
    // Gate BOTH reads + registration. Eager paint still fires (ready=true) while
    // the fetch is in flight — exactly the warm-cache window.
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    // Eager paint must already have emitted (ready). This is the warm-cache path.
    expect(states.length, "eager paint sets ready before the fetch resolves").toBeGreaterThanOrEqual(1);

    // Pre-fetch SSE CREATE in the window — NOT in the (already-captured) fetch.
    stub.emit("items", { action: "create", record: rec("items", { id: "new", list: "L1" }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last.map((r) => r.id).sort(), "warm-cache pre-fetch create must NOT be tombstoned").toEqual(["c1", "new"]);
    // And it must not be IDB-tombstoned (the wrong-tombstone-to-IDB hazard).
    expect(wpb.collection("items").view("new"), "create must stay live in the queue").not.toBeNull();
    await flushSnapshotWriter();
    expect((await loadSnapshotsForUser("user-A")).map((r) => r.id), "create must be persisted, not tombstoned in IDB").toContain("new");
  });

  it("a pre-fetch SSE DELETE during a warm-cache (eager-ready) bootstrap stays deleted, not resurrected", async () => {
    // Cache holds c1 + c2 (both server-backed) → eager paint sets ready=true.
    await seedSnapshots([
      { key: "user-A::items::c1", user: "user-A", collection: "items", id: "c1", record: rec("items", { id: "c1", list: "L1", name: "keep" }), updatedAt: Date.now() },
      { key: "user-A::items::c2", user: "user-A", collection: "items", id: "c2", record: rec("items", { id: "c2", list: "L1", name: "doomed" }), updatedAt: Date.now() },
    ]);

    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    // Fetch (gated) STILL carries both c1 and c2 — the delete races in after the
    // fetch query was captured, so the stale fetch would re-seed c2.
    stub.col("items").records.set("c1", rec("items", { id: "c1", list: "L1", name: "keep" }));
    stub.col("items").records.set("c2", rec("items", { id: "c2", list: "L1", name: "doomed" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => states.push(s),
    );
    await flush();

    expect(states.length, "eager paint sets ready before the fetch resolves").toBeGreaterThanOrEqual(1);

    // Pre-fetch SSE DELETE of c2 in the window — gated fetch STILL has c2.
    stub.emit("items", { action: "delete", record: rec("items", { id: "c2", list: "L1" }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last.map((r) => r.id), "warm-cache pre-fetch delete must stay deleted (not resurrected by the stale fetch)").toEqual(["c1"]);
    expect(wpb.collection("items").view("c2"), "delete must win in the queue").toBeNull();
  });

  it("STEP 3: warm-cache sort+limit window under-fill — a pre-fetch DELETE of an in-window record backfills (not N-1)", async () => {
    // The step-2 review flagged this: a warm-cache eager-ready SORT+LIMIT slice
    // whose cache holds exactly the top-N, then a pre-fetch SSE DELETE vacates a
    // window slot. The server is fully CONSISTENT (the deleted row is really
    // gone, and a below-window record exists to promote). Pre-step-3 the eager
    // paint set membership to the cached top-N, the pre-fetch delete dropped one,
    // and nothing pulled in the below-window record → the window rendered N-1.
    // Step 3 fixes it: the bootstrap fetch is a full page (it returns `limit`
    // rows, with the below-window record now promoted), and windowDirtyDuring
    // Bootstrap arms a top-N refetch that backfills the slot.
    //
    // Cache holds the top-2 (b:t=3, a:t=2) — eager paint sets ready. Server ALSO
    // has c:t=1 below the window. A pre-fetch DELETE of 'a' (in-window) must
    // promote 'c' so the window stays full at [b, c].
    await seedSnapshots([
      { key: "user-A::log::a", user: "user-A", collection: "log", id: "a", record: rec("log", { id: "a", t: 2 }), updatedAt: Date.now() },
      { key: "user-A::log::b", user: "user-A", collection: "log", id: "b", record: rec("log", { id: "b", t: 3 }), updatedAt: Date.now() },
    ]);

    const stub = makeStubPb();
    stub.authStore.setRecord("user-A");
    // Server truth: b(3), a(2) in-window; c(1) below. (After the delete of 'a',
    // the true top-2 is [b, c].)
    stub.col("log").records.set("a", rec("log", { id: "a", t: 2 }));
    stub.col("log").records.set("b", rec("log", { id: "b", t: 3 }));
    stub.col("log").records.set("c", rec("log", { id: "c", t: 1 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    await wpb.hydrateSnapshots();

    const states: RawRecord[][] = [];
    // Gate the fetch + registration so eager paint sets ready (warm-cache window)
    // while the bootstrap getList is still in flight.
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch({ collection: "log", topic: "*", sort: "-t", limit: 2 }, (s) => states.push(s));
    await flush();

    expect(states.length, "eager paint sets ready before the fetch resolves").toBeGreaterThanOrEqual(1);
    // Eager-painted window is the cached top-2 [b, a].
    expect(states[states.length - 1].map((r) => r.id), "warm-cache paints the cached top-N").toEqual(["b", "a"]);

    // Pre-fetch SSE DELETE of in-window 'a'. Commit it server-side too so the
    // gated bootstrap getList (snapshotted when reads release) returns the true
    // full page [b, c] (c promoted). The delete tombstones 'a' in the queue.
    stub.emit("log", { action: "delete", record: rec("log", { id: "a", t: 2 }) });
    stub.col("log").records.delete("a");
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush(8);

    const last = states[states.length - 1];
    expect(last.map((r) => r.id), "deleted in-window slot must backfill from below-window (not N-1)").toEqual(["b", "c"]);
    expect(last.length, "window stays full at N").toBe(2);
    expect(wpb.collection("log").view("a"), "deleted record stays tombstoned in the queue").toBeNull();
  });
});

// =====================================================================
// REVIEW MATRIX CELL 2 — two slices sharing one collection, one torn down mid-bootstrap
// =====================================================================
//
// S1 + S2 watch the SAME collection (refcount 2 on the shared listener). Both
// bootstraps are gated. S1 is torn down DURING the await — teardownSlice already
// released the listener (refcount 2→1). The cancel-before-resolve early-return
// in bootstrap must then NOT release a SECOND time (refcount would drop to 0 and
// destroy the listener S2 still needs). FAILS on the pre-fix code (unconditional
// release in the early-return).

describe("MATRIX 2: shared-collection refcount survives a teardown-during-bootstrap", () => {
  it("tearing down one slice mid-bootstrap keeps the SHARED listener alive for the surviving slice", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    stub.col("items").records.set("b", rec("items", { id: "b", list: "L2" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    // Gate reads so both bootstraps pend in their fetch await with the listener
    // refcount already bumped to 2 (one per slice on the SAME collection).
    stub.holdReads();

    const s1States: RawRecord[][] = [];
    const s2States: RawRecord[][] = [];
    // Two DIFFERENT slices (different filter) on the same collection → one shared
    // collection listener, refcount 2.
    const h1 = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => s1States.push(s),
    );
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L2'", predicate: (r) => r.list === "L2" },
      (s) => s2States.push(s),
    );
    await flush();

    // Exactly ONE shared collection subscribe for both slices.
    expect(stub.col("items").subscribeCalls, "one shared listener for two slices").toBe(1);
    expect(stub.col("items").realtimeCbs.size, "listener registered").toBe(1);

    // Tear down S1 WHILE both bootstraps are still awaiting the gated fetch.
    // teardownSlice releases the listener once (refcount 2→1).
    h1.unsubscribe();

    // Release the fetch → both bootstraps resume; S1's early-return must NOT
    // release the listener a second time (would drop refcount 1→0 and kill it).
    stub.releaseReads();
    await flush();

    // The shared listener MUST still be live for S2.
    expect(stub.col("items").realtimeCbs.size, "shared listener must survive S1 teardown").toBe(1);

    // And S2 must keep receiving SSE events.
    s2States.length = 0;
    stub.emit("items", { action: "create", record: rec("items", { id: "c", list: "L2" }) });
    await flush();
    const last = s2States[s2States.length - 1];
    expect(last?.map((r) => r.id).sort(), "surviving slice still receives SSE").toEqual(["b", "c"]);
  });
});

// =====================================================================
// REVIEW MATRIX CELL 3 — sort+limit at the actual limit boundary
// =====================================================================
//
// limit=2 with 3 records (one below the window). Two cases:
//   - a pre-ready CREATE that pushes a fetched record OUT of the window (guard
//     for the existing touched-set-merge — already works),
//   - a pre-ready DELETE that vacates a window slot → the below-window record
//     must be pulled in by the post-consolidation refetch (the MINOR fix).

describe("MATRIX 3: sort+limit at the limit boundary", () => {
  it("pre-ready CREATE pushes a fetched record out of the window (guard)", async () => {
    const stub = makeStubPb();
    // Server top-2 (sort -t): b(t=3), a(t=2). c(t=1) is below the window.
    stub.col("log").records.set("a", rec("log", { id: "a", t: 2 }));
    stub.col("log").records.set("b", rec("log", { id: "b", t: 3 }));
    stub.col("log").records.set("c", rec("log", { id: "c", t: 1 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch({ collection: "log", topic: "*", sort: "-t", limit: 2 }, (s) => states.push(s));
    await flush();

    // Pre-ready CREATE 'd' with the highest rank → pushes 'a' out of the top-2.
    // A real SSE create echoes a COMMITTED record, so mirror the commit
    // server-side now: the post-ready backfill refetch (armed because the
    // bootstrap page was FULL — limit=2, 2 rows fetched) then sees the true
    // top-2 [d, b]. (Arming on a create is the accepted "redundant refetch is
    // harmless" simplification; with the server consistent it converges right.)
    stub.col("log").records.set("d", rec("log", { id: "d", t: 9 }));
    stub.emit("log", { action: "create", record: rec("log", { id: "d", t: 9 }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last.map((r) => r.id), "highest-rank create takes the window; lowest is evicted").toEqual(["d", "b"]);
  });

  it("pre-ready DELETE vacates a window slot → the below-window record is pulled in", async () => {
    const stub = makeStubPb();
    // Server has 3 records; top-2 window is b(t=3), a(t=2). c(t=1) is below.
    stub.col("log").records.set("a", rec("log", { id: "a", t: 2 }));
    stub.col("log").records.set("b", rec("log", { id: "b", t: 3 }));
    stub.col("log").records.set("c", rec("log", { id: "c", t: 1 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    // Gate the BOOTSTRAP fetch. With all 3 records present, the gated getList
    // snapshots the PRE-delete top-2 [b, a] at call time (it cannot see c — c is
    // below the window). Essential: if the fetch saw post-delete state it would
    // already pull c in and the refetch would be untested.
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch({ collection: "log", topic: "*", sort: "-t", limit: 2 }, (s) => states.push(s));
    await flush();

    // Pre-ready DELETE of 'a' (a top-N member) vacates a window slot. The gated
    // bootstrap fetch already snapshotted [b, a], so the touched-set merge leaves
    // the window at [b] — N-1, under-filled. Mirror the commit server-side now so
    // the post-consolidation REFETCH (issued AFTER reads release, snapshotted at
    // its own call time) returns the true top-2 [b, c] with c promoted.
    stub.emit("log", { action: "delete", record: rec("log", { id: "a", t: 2 }) });
    stub.col("log").records.delete("a");
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    await flush();

    const last = states[states.length - 1];
    expect(last.map((r) => r.id), "deleted slot must be backfilled by the below-window record (refetch)").toEqual(["b", "c"]);
    expect(last.length, "window must be full again (N, not N-1)").toBe(2);
    expect(wpb.collection("log").view("a"), "deleted record stays deleted").toBeNull();
  });
});

// =====================================================================
// TERMINATION REGRESSION — the refetch must NOT hammer getList forever
// =====================================================================
//
// The fuzzer is structurally blind to this: it drains to quiescence and reads
// the last emit, so an UNBOUNDED refetch loop that still converges every frame
// would pass it. This test reproduces the reviewer's storm scenario directly:
// a sort+limit slice at a full window, a pre-ready DELETE of a windowed id, and
// a LAGGING server whose getList still returns the deleted id forever (a commit
// lagging its own broadcast, or a recreate whose echo was lost). The removed
// `pendingWindowTombstones` suppression turned this into: drop the row → window
// under-fills → re-arm a full-page refetch → drop again → ∞. With the plain
// (non-suppressing) refetch the row simply shows for one frame and the refetch
// count stays BOUNDED. Asserting a small bound documents the hazard so it can't
// silently regress.
describe("TERMINATION: lagging getList must not cause an unbounded refetch storm", () => {
  it("a pre-ready delete whose row the server keeps returning does NOT loop", async () => {
    const stub = makeStubPb();
    // Full window: top-2 is b(t=3), a(t=2). c(t=1) is below.
    stub.col("log").records.set("a", rec("log", { id: "a", t: 2 }));
    stub.col("log").records.set("b", rec("log", { id: "b", t: 3 }));
    stub.col("log").records.set("c", rec("log", { id: "c", t: 1 }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    stub.holdReads();
    stub.holdRegistration();
    mirror.watch({ collection: "log", topic: "*", sort: "-t", limit: 2 }, (s) => states.push(s));
    await flush();

    // Pre-ready DELETE of windowed 'a'. CRUCIALLY: do NOT remove 'a' from the
    // server records — the lagging getList keeps returning it. The mirror has
    // tombstoned 'a' in the queue (applyServer(null)); every refetch's top-N is
    // [b, a] (still carrying the ghost).
    stub.emit("log", { action: "delete", record: rec("log", { id: "a", t: 2 }) });
    await flush();

    stub.releaseReads();
    stub.releaseRegistration();
    // Drain hard — a refetch storm would keep re-arming across many ticks.
    await flush(40);

    // The fetch count is BOUNDED: bootstrap fetch + at most a small handful of
    // backfill refetches, NOT hundreds. (Pre-fix this would climb with every
    // tick. We assert a loose bound so a legitimate coalesced refetch or two is
    // fine but a storm is caught.)
    expect(stub.col("log").fetchCalls, "getList must not be hammered in a loop").toBeLessThanOrEqual(5);
    // Accepted one-frame-stale: the lagging server still returns 'a', so the
    // final window may carry it — but the QUEUE keeps it tombstoned, and the
    // next real SSE event / resync corrects the view. Convergence is delegated
    // to resync (see the fuzzer's post-resync checkpoint); here we only assert
    // termination.
    expect(wpb.collection("log").view("a"), "queue stays tombstoned regardless of the lagging fetch").toBeNull();
  });
});
