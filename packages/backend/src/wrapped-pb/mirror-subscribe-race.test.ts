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
          if (c.gateReads) await c.gateReads;
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
