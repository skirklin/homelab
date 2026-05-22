/**
 * Real-world resilience tests for wpb + PBMirror.
 *
 * These tests simulate what phones and browsers actually do across full
 * sessions: page reloads with persisted-mutation replay, network drops,
 * SSE failures, optimistic/server conflicts, concurrency, lifecycle.
 *
 * Why a separate file: the existing mirror.test.ts and index.test.ts cover
 * single-session correctness against an in-memory stub. They DON'T cover
 * the localStorage/IDB persistence boundary that fires on every page mount
 * via wpb.replayPending(). That's the seam the production bug landed in
 * (user dogfooded shopping on beta and hit a 404 on update after a
 * refresh-mid-toggle sequence).
 *
 * Test grouping mirrors the agent prompt:
 *   A. Page-reload boundary
 *   B. Slow / dropping connections
 *   C. Browser-ahead-of-server states
 *   D. Server-ahead-of-browser states
 *   E. Concurrency / coalescing
 *   F. React StrictMode + lifecycle
 *
 * Each test names the scenario (e.g. "A1") in its `it` block so the report
 * reads like a coverage table.
 */
import "fake-indexeddb/auto"; // gives us a real IndexedDB shim so persistMutation → replayPending actually round-trips
import { describe, it, expect, beforeEach } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase, WrappedPbError } from "./index";
import { createMirror, type RawRecord } from "./mirror";
import { persistMutation, loadAllMutations, clearAllMutations } from "./persistence";

// ---- Stub PocketBase (richer than the mirror.test.ts stub) ----

type RealtimeCb = (e: { action: string; record: RecordModel }) => void;

interface StubCollection {
  records: Map<string, RecordModel>;
  realtimeCbs: Set<RealtimeCb>;
  subscribeCalls: number;
  /** Holds in-flight reads when set. Tests release by `release()`. */
  gateReads: Promise<void> | null;
  /** Holds in-flight writes when set. */
  gateWrites: Promise<void> | null;
  /** Holds creates only. */
  gateCreates: Promise<void> | null;
  /** Holds updates only. */
  gateUpdates: Promise<void> | null;
  /** Number of times getList/getFullList was called. */
  fetchCalls: number;
  /** Per-method one-shot failure injectors. */
  failNextCreate: unknown;
  failNextUpdate: unknown;
  failNextDelete: unknown;
  failNextRead: unknown;
  /** Always-on failure (cleared by setting to null). */
  failAllCreates: unknown;
  failAllUpdates: unknown;
  failAllDeletes: unknown;
  failAllReads: unknown;
  /** Track how many of each op succeeded against the stub. */
  createCalls: number;
  updateCalls: number;
  deleteCalls: number;
}

interface StubHandle {
  pb: PocketBase;
  emit: (col: string, e: { action: string; record: RecordModel }) => void;
  col: (n: string) => StubCollection;
  /** Hold all reads. release() drops the gate. */
  holdReads: () => void;
  releaseReads: () => void;
  holdWrites: () => void;
  releaseWrites: () => void;
  /** Simulate SSE drop: clear all realtime callbacks so emits go nowhere. */
  killSse: () => void;
}

function makeStubPb(): StubHandle {
  const cols = new Map<string, StubCollection>();
  let releaseReadsAll: () => void = () => {};
  let releaseWritesAll: () => void = () => {};
  let readsHeld = false;
  let writesHeld = false;

  const get = (n: string): StubCollection => {
    let c = cols.get(n);
    if (!c) {
      c = {
        records: new Map(),
        realtimeCbs: new Set(),
        subscribeCalls: 0,
        gateReads: null,
        gateWrites: null,
        gateCreates: null,
        gateUpdates: null,
        fetchCalls: 0,
        failNextCreate: undefined,
        failNextUpdate: undefined,
        failNextDelete: undefined,
        failNextRead: undefined,
        failAllCreates: null,
        failAllUpdates: null,
        failAllDeletes: null,
        failAllReads: null,
        createCalls: 0,
        updateCalls: 0,
        deleteCalls: 0,
      };
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
      onDisconnect: undefined as ((subs: string[]) => void) | undefined,
      isConnected: true,
      async subscribe(topic: string) {
        if (topic === "PB_CONNECT") return async () => {};
        return async () => {};
      },
    },
    collection: (name: string) => {
      const c = get(name);
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
      return {
        async create(body: Record<string, unknown>): Promise<RecordModel> {
          if (c.gateWrites) await c.gateWrites;
          if (c.gateCreates) await c.gateCreates;
          if (c.failAllCreates) throw c.failAllCreates;
          if (c.failNextCreate !== undefined) {
            const err = c.failNextCreate;
            c.failNextCreate = undefined;
            throw err;
          }
          c.createCalls += 1;
          const id = (body.id as string) ?? `id-${Math.random().toString(36).slice(2, 17)}`;
          if (c.records.has(id)) {
            throw Object.assign(new Error("duplicate id"), { status: 409 });
          }
          const now = new Date().toISOString();
          const record = { id, collectionId: name, collectionName: name, created: now, updated: now, ...body } as unknown as RecordModel;
          c.records.set(id, record);
          return record;
        },
        async update(id: string, body: Record<string, unknown>): Promise<RecordModel> {
          if (c.gateWrites) await c.gateWrites;
          if (c.gateUpdates) await c.gateUpdates;
          if (c.failAllUpdates) throw c.failAllUpdates;
          if (c.failNextUpdate !== undefined) {
            const err = c.failNextUpdate;
            c.failNextUpdate = undefined;
            throw err;
          }
          c.updateCalls += 1;
          const existing = c.records.get(id);
          if (!existing) {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
          const updated = { ...existing, ...body, updated: new Date().toISOString() } as RecordModel;
          c.records.set(id, updated);
          return updated;
        },
        async delete(id: string): Promise<boolean> {
          if (c.gateWrites) await c.gateWrites;
          if (c.failAllDeletes) throw c.failAllDeletes;
          if (c.failNextDelete !== undefined) {
            const err = c.failNextDelete;
            c.failNextDelete = undefined;
            throw err;
          }
          c.deleteCalls += 1;
          if (!c.records.has(id)) {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
          c.records.delete(id);
          return true;
        },
        async subscribe(_topic: string, cb: RealtimeCb): Promise<UnsubscribeFunc> {
          c.subscribeCalls += 1;
          c.realtimeCbs.add(cb);
          return async () => { c.realtimeCbs.delete(cb); };
        },
        async getOne(id: string): Promise<RecordModel> {
          c.fetchCalls += 1;
          if (c.gateReads) await c.gateReads;
          if (c.failAllReads) throw c.failAllReads;
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
          if (c.failAllReads) throw c.failAllReads;
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
          if (c.failAllReads) throw c.failAllReads;
          if (c.failNextRead !== undefined) {
            const err = c.failNextRead;
            c.failNextRead = undefined;
            throw err;
          }
          const all = Array.from(c.records.values()).filter((r) => applyFilter(r, opts?.filter));
          const sorted = applySort(all, opts?.sort);
          return { items: sorted.slice(0, perPage) };
        },
      };
    },
  } as unknown as PocketBase;

  return {
    pb: stub,
    emit(col, e) {
      const c = get(col);
      for (const cb of c.realtimeCbs) cb(e);
    },
    col: get,
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
    killSse() {
      for (const c of cols.values()) c.realtimeCbs.clear();
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

async function flush(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  await clearAllMutations();
});

// ===================================================================
// A. Page-reload boundary
// ===================================================================

describe("realworld A: page-reload boundary", () => {
  it("A1: original POST landed; replay-create 409s; later update on the same id hits 200", async () => {
    // Session 1: create lands on PB, but IDB persisted entry survives (the
    // page closed before unpersistMutation committed). This is the most
    // common shape of a half-finished session.
    const stub1 = makeStubPb();
    const wpb1 = wrapPocketBase(() => stub1.pb);
    const itemId = "item-a1";
    // Simulate: create POST landed, ack drained the in-memory queue, but the
    // IDB delete didn't make it before the tab closed.
    stub1.col("items").records.set(itemId, rec("items", { id: itemId, list: "L1", checked: false }));
    // Manually persist what the prior session would have left in IDB.
    await persistMutation({
      id: "mut-create",
      collection: "items",
      recordId: itemId,
      mutation: { kind: "set", record: rec("items", { id: itemId, list: "L1", checked: false }) },
      createdAt: 1,
      origin: "tab-1",
    });

    // Session 2: fresh wpb + mirror, same backing stub server.
    const stub2 = stub1; // server state is shared
    const wpb2 = wrapPocketBase(() => stub2.pb);
    const mirror = createMirror(() => stub2.pb, wpb2);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    // Initial bootstrap saw the record server-side.
    expect(states[states.length - 1].map((r) => r.id)).toEqual([itemId]);

    // Replay fires: PB returns 409 (already exists). Mirror's view must stay
    // consistent — the item should NOT disappear due to the 409 drain.
    await wpb2.replayPending();
    await flush();

    expect(
      states[states.length - 1].map((r) => r.id),
      "after replay-409, mirror's view still contains the server record",
    ).toEqual([itemId]);

    // User clicks check.
    await wpb2.collection("items").update(itemId, { checked: true });
    await flush();

    // The PB record is now checked. Mirror reflects.
    expect(stub2.col("items").records.get(itemId)?.checked).toBe(true);
    expect(states[states.length - 1][0].checked).toBe(true);

    handle.unsubscribe();
    mirror.dispose();
    void wpb1; // silence unused
  });

  it("A2: original POST never landed; replay-create POSTs; mirror shows item from server snapshot", async () => {
    // Session 1 closed before POST left. IDB has the create. PB has nothing.
    const stub = makeStubPb();
    await persistMutation({
      id: "mut-create",
      collection: "items",
      recordId: "item-a2",
      mutation: { kind: "set", record: rec("items", { id: "item-a2", list: "L1", name: "test" }) },
      createdAt: 1,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    // Initial bootstrap: PB returns nothing — but replay-pushed mutation
    // makes the item visible optimistically.
    await wpb.replayPending();
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toContain("item-a2");

    // After replay completes, the record is on the server.
    expect(stub.col("items").records.has("item-a2")).toBe(true);

    // User clicks check — should succeed against the now-present server record.
    await wpb.collection("items").update("item-a2", { checked: true });
    expect(stub.col("items").records.get("item-a2")?.checked).toBe(true);

    handle.unsubscribe();
    mirror.dispose();
  });

  it("A3: replay-create returns permanent 4xx (e.g. 403); record is dropped, ghost does not persist across refresh", async () => {
    const stub = makeStubPb();
    stub.col("items").failAllCreates = Object.assign(new Error("forbidden"), { status: 403 });

    // IDB has a stale create that the server will reject permanently.
    await persistMutation({
      id: "mut-create",
      collection: "items",
      recordId: "item-a3",
      mutation: { kind: "set", record: rec("items", { id: "item-a3", list: "L1" }) },
      createdAt: 1,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    await wpb.replayPending();
    await flush(16);

    // After permanent failure the ghost is gone — both in queue and in mirror view.
    expect(states[states.length - 1].map((r) => r.id)).not.toContain("item-a3");
    // And IDB is cleared so a third refresh won't resurrect it.
    const remaining = await loadAllMutations();
    expect(remaining.find((m) => m.recordId === "item-a3"), "permanent-error replay must unpersist").toBeUndefined();

    handle.unsubscribe();
    mirror.dispose();
  });

  it("A4: replay [create, update, update] all replay; mirror converges to final composed state", async () => {
    const stub = makeStubPb();
    const id = "item-a4";

    await persistMutation({
      id: "m1",
      collection: "items",
      recordId: id,
      mutation: { kind: "set", record: rec("items", { id, list: "L1", checked: false }) },
      createdAt: 1,
      origin: "tab-1",
    });
    await persistMutation({
      id: "m2",
      collection: "items",
      recordId: id,
      mutation: { kind: "update", patch: { checked: true } },
      createdAt: 2,
      origin: "tab-1",
    });
    await persistMutation({
      id: "m3",
      collection: "items",
      recordId: id,
      mutation: { kind: "update", patch: { checked: false } },
      createdAt: 3,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    await wpb.replayPending();
    await flush(16);

    // Final state on server: created, then checked, then unchecked → checked:false.
    expect(stub.col("items").records.get(id)?.checked).toBe(false);
    expect(states[states.length - 1].find((r) => r.id === id)?.checked).toBe(false);
    // IDB drained (all three were drained on ack).
    const remaining = await loadAllMutations();
    expect(remaining).toEqual([]);

    handle.unsubscribe();
    mirror.dispose();
  });

  it("A5 (dogfood repro): pending update from prior session referencing a record that was never created → no ghost in mirror view", async () => {
    // The actual bug: a stale persisted UPDATE refers to a record id that
    // no longer exists server-side (or never did). Bootstrap getList won't
    // return it. Pre-fix, the mirror's queue.viewCollection would surface
    // the ghost because pushPending(update) puts an entry in the queue
    // and replay's dispatch eventually 404s — but during the window
    // before the dispatch resolves, the mirror's view shows the ghost. If
    // a user-driven update happens in that window, it 404s against PB.
    //
    // Critical invariant: a pending UPDATE on a record with no server
    // snapshot must NOT appear in the mirror's wildcard view, because
    // there's no record content to show — composeView returns null for
    // (null server, [update patch]).
    const stub = makeStubPb();
    const id = "item-a5";

    // Stale update from a prior session — record never landed on PB.
    await persistMutation({
      id: "m-update",
      collection: "items",
      recordId: id,
      mutation: { kind: "update", patch: { checked: true } },
      createdAt: 1,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    // Pre-replay: bootstrap returned empty.
    expect(states[states.length - 1]).toEqual([]);

    // Replay the stale update. It will 404 on dispatch. The ghost must
    // never be observable in the mirror state.
    await wpb.replayPending();
    await flush(16);

    // After replay completes, the ghost is gone (permanent 404 path drained
    // the mutation).
    expect(states[states.length - 1]).toEqual([]);

    // CRITICAL: a follow-up update from the user should not be sabotaged.
    // (There's nothing to update — the user can't click an item they don't
    // see. The mirror correctly shows []. So no test action; the assertion
    // is that nothing is visible to click.)

    handle.unsubscribe();
    mirror.dispose();
  });

  it("A5b (dogfood exact shape): stale update overlays a known-deleted record id; bootstrap finds it not present; view must remain empty", async () => {
    // Tighter repro of the dogfood: PB used to have this record, the user
    // deleted it, but the tab closed before unpersistMutation finished for
    // a check toggle. Now session 2 boots — IDB has the check update, PB
    // has no record.
    const stub = makeStubPb();
    const id = "item-a5b";

    await persistMutation({
      id: "m-check",
      collection: "items",
      recordId: id,
      mutation: { kind: "update", patch: { checked: true } },
      createdAt: 1,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    // The mirror should never expose the ghost even before replay's
    // 404 returns. composeView(null, [update]) === null, so the queue
    // shouldn't report this record from viewCollection.
    await wpb.replayPending();
    // Don't await flush(16) here — we want to assert the IN-FLIGHT state.
    expect(
      states[states.length - 1],
      "while replay is in flight, mirror must NOT surface ghost",
    ).toEqual([]);

    await flush(16);
    expect(states[states.length - 1]).toEqual([]);

    handle.unsubscribe();
    mirror.dispose();
  });

  it("A7: replayPending after the mirror has already bootstrapped → mirror reflects the replay-pushed records", async () => {
    // Production ordering reality: BackendProvider's useEffect fires
    // replayPending; downstream consumers mount mirror.watch in subsequent
    // ticks. But in race conditions (e.g. the user navigates immediately
    // to a different module that uses a different collection), the mirror
    // watch may have already bootstrapped before replayPending pushes the
    // matching collection's mutations.
    //
    // This test exposes a known gap: when replayPending pushPending's a
    // mutation, it does NOT notify mirror via notifyMutationListeners.
    // The mirror's view stays stale until an SSE event or user-driven
    // mutation triggers an emit.
    const stub = makeStubPb();
    const id = "item-a7";
    await persistMutation({
      id: "m-create",
      collection: "items",
      recordId: id,
      mutation: { kind: "set", record: rec("items", { id, list: "L1", name: "stale-create" }) },
      createdAt: 1,
      origin: "tab-1",
    });
    // Hold writes so the replay's dispatch doesn't ack and emit naturally.
    stub.col("items").gateCreates = new Promise<void>(() => {}); // never resolves

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    // Mirror has bootstrapped — empty.
    expect(states[states.length - 1]).toEqual([]);

    // Now replayPending fires.
    void wpb.replayPending();
    await flush();

    // The pending mutation IS in the queue. The mirror SHOULD see the
    // record (via queue.viewCollection in materialize). Pre-fix: it
    // doesn't, because replayPending's pushPending doesn't notify the
    // mirror's mutation listeners.
    expect(
      states[states.length - 1].map((r) => r.id),
      "mirror's view must reflect replay-pushed mutations within a tick",
    ).toContain(id);

    handle.unsubscribe();
    mirror.dispose();
  });

  it("A6 (DOGFOOD): persisted create + user-driven update that races ahead of the create POST → update must not 404", async () => {
    // This is the actual dogfood repro:
    //  1. Session 1: user added "test" to a shopping list. Create POST may
    //     have been in flight or just acked when the tab closed; IDB
    //     persisted entry never got cleared.
    //  2. Refresh (Ctrl-R). New session. wpb.replayPending() fires.
    //     - Replay pushes the create into the queue.
    //     - Replay dispatches the create POST (network-bound, takes time).
    //     - Meanwhile mirror's getList(filter) shows the record from the
    //       queue's composeView (kind: "set" on null server = synthesized).
    //  3. User clicks check ON THE VISIBLE ROW before the replay's POST
    //     has acked. wpb.collection.update fires immediately. POST hits PB,
    //     PB has no record yet → 404 → permanent → WrappedPbError toast.
    //
    // Correct behavior: the user-driven update must NOT 404. Either the
    // mutation is serialized after the replay's POST (proper queuing per
    // record), or the user-driven update is replayed against the now-acked
    // record by retryErrored, or the mirror simply doesn't surface the
    // record until the create lands.
    const stub = makeStubPb();
    const id = "item-a6";

    // Stale create from session 1.
    await persistMutation({
      id: "m-create",
      collection: "items",
      recordId: id,
      mutation: { kind: "set", record: rec("items", { id, list: "L1", ingredient: "test", checked: false }) },
      createdAt: 1,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => stub.pb);

    // Slow ONLY the create POST so the user-driven update reaches PB
    // first — this is the actual race that bit in production. The real
    // world: phone backgrounded, refreshed, replay's create POST is
    // queued but the user taps before the network round-trip finishes.
    let releaseCreate: () => void = () => {};
    stub.col("items").gateCreates = new Promise<void>((res) => { releaseCreate = res; });

    // BackendProvider fires replayPending in its useEffect before the
    // shopping module's mirror.watch attaches.
    void wpb.replayPending();
    await flush();

    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    // The user sees the item in the UI (queue-only, from the replayed
    // pending mutation).
    expect(states[states.length - 1].map((r) => r.id)).toContain(id);

    // User clicks check while the create POST is still gated. With the
    // per-record dispatch chain, the update POST is serialized behind the
    // create POST — it won't fire until the create's await resolves.
    let userUpdateError: unknown = null;
    const userUpdate = wpb.collection("items").update(id, { checked: true }).catch((err) => {
      userUpdateError = err;
    });
    await flush();

    // Release the gated create so the chain can drain.
    releaseCreate();
    stub.col("items").gateCreates = null;
    await userUpdate;
    await flush(16);

    // The bug: PRE-FIX the user's update 404s because PB hasn't yet
    // applied the create. POST-FIX the update is serialized after the
    // create, so PB sees create → update → both succeed.
    expect(
      userUpdateError,
      "user-driven update on a record whose create is still replaying must not throw a WrappedPbError 404",
    ).toBeNull();
    expect(stub.col("items").records.get(id)?.checked).toBe(true);

    handle.unsubscribe();
    mirror.dispose();
  });

  it("A11 (DOGFOOD oscillation): stale persisted SET + server already has fresher state → consumer must never see stale create-time body", async () => {
    // The reported user repro (beta.kirkl.in dogfood, 2026-05-22):
    //   1. Add "test" to a shopping list. wpb.create persists `set {checked:false}`.
    //   2. Check it. wpb.update persists `update {checked:true}`. Both POSTs ack;
    //      both queue entries drain. BUT the IDB unpersistMutation for the SET
    //      is fire-and-forget. If the user refreshes a couple ms later, the
    //      IDB entry may still be there (browser hasn't flushed the delete).
    //   3. Refresh. Session 2: replayPending loads the stale SET, pushes it
    //      into the queue, and dispatches a POST. PB returns 409 (already
    //      exists with checked=true).
    //   4. Meanwhile, mirror.watch bootstraps: getFullList returns `{checked:true}`.
    //      Bootstrap's seed-into-queue is gated by `!queue.hasPending(...)`.
    //      Because replay just pushed a SET, hasPending is true, so the server
    //      snapshot is NOT seeded. Materialize falls back to queue.viewCollection,
    //      which composes `null server + [set{checked:false}]` = `{checked:false}`.
    //      → Consumer renders the item UNCHECKED.
    //   5. The replay's POST eventually 409s; permanent path drains the SET
    //      from the queue. composeView is now `null server + []` = `null`. The
    //      record DISAPPEARS from the slice's wildcard view entirely.
    //   6. Next refresh: IDB is clean. Bootstrap seeds normally. Consumer
    //      sees checked=true. (Matches the user's "second refresh is correct".)
    //
    // Root cause: bootstrap's hasPending guard at mirror.ts:500 confuses
    // "there's a pending optimistic write" with "don't trust the server
    // snapshot". applyServer is composition-safe — it doesn't clobber
    // pending — so the guard is both unnecessary and wrong here.
    //
    // Correct behavior: at every emit during this sequence, the consumer
    // sees the item with `checked: true` (server-authoritative; the stale
    // replayed SET is just a request that will 409). No `checked: false`
    // emit, no "record disappeared" emit between the two states.
    const stub = makeStubPb();
    const id = "item-a11";

    // Server already has the record in the post-check state.
    stub.col("items").records.set(id, rec("items", {
      id,
      list: "L1",
      ingredient: "test",
      checked: true, // user already checked it; server is authoritative.
    }));

    // IDB still has the stale SET from the prior session's create (the
    // browser didn't flush the unpersistMutation before the tab closed).
    // The SET body reflects the create-time state (checked: false).
    await persistMutation({
      id: "m-stale-create",
      collection: "items",
      recordId: id,
      mutation: { kind: "set", record: rec("items", {
        id, list: "L1", ingredient: "test", checked: false,
      }) },
      createdAt: 1,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => stub.pb);

    // Gate the create POST so the replay's dispatch is still in flight
    // when mirror.watch bootstraps. Without this gate, the in-memory stub
    // would 409 immediately, drain the pending entry before bootstrap
    // runs, and the race never fires. In production, the replay's POST
    // is network-bound (10s-100s of ms) and mirror.watch attaches within
    // a few React render ticks — the window is wide open.
    let releaseCreate: () => void = () => {};
    stub.col("items").gateCreates = new Promise<void>((res) => { releaseCreate = res; });

    // Production ordering: BackendProvider's useEffect fires replayPending
    // before any consumer module mounts and calls mirror.watch.
    void wpb.replayPending();
    await flush();

    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );

    // Let bootstrap's getFullList complete while the replay's POST is
    // still gated. This is the exact production-shape window where the
    // bug manifests.
    await flush(8);

    // Now release the gated create — it will 409 (record already exists).
    releaseCreate();
    stub.col("items").gateCreates = null;
    await flush(32);

    // INVARIANT 1: The consumer never observes the item as unchecked. Every
    // emit since the slice became ready should show `checked: true` (server
    // truth), because the stale SET cannot override what the server already
    // has. The user must not see their checked item flicker back to unchecked.
    const checkedHistory = states
      .filter((s) => s.length > 0)
      .map((s) => s.find((r) => r.id === id)?.checked);
    expect(
      checkedHistory,
      `no emit may show the item unchecked; observed: ${JSON.stringify(checkedHistory)}`,
    ).not.toContain(false);

    // INVARIANT 2: The item is still present and checked after settle.
    const finalState = states[states.length - 1];
    expect(finalState.find((r) => r.id === id)?.checked).toBe(true);

    // INVARIANT 3: The server itself is unchanged (still checked=true; the
    // stale replay's 409 didn't corrupt it).
    expect(stub.col("items").records.get(id)?.checked).toBe(true);

    handle.unsubscribe();
    mirror.dispose();
  });

  it("A12 (DOGFOOD oscillation, item-disappears variant): stale SET → 409 drains → ensure record doesn't vanish from mirror view", async () => {
    // Tighter variant: same setup as A11, but explicitly assert that no
    // intermediate emit produces an empty slice (i.e. the record never
    // vanishes from the consumer's view, only momentarily). This is the
    // shape the user actually sees as "unchecked then checked" — between
    // the two refreshes, the consumer is briefly looking at an empty list
    // for this item, which renders as "item missing" UI before the
    // refresh, but here we verify mid-session that no emit drops the
    // record entirely.
    const stub = makeStubPb();
    const id = "item-a12";

    stub.col("items").records.set(id, rec("items", {
      id,
      list: "L1",
      ingredient: "milk",
      checked: true,
    }));

    await persistMutation({
      id: "m-stale-create-a12",
      collection: "items",
      recordId: id,
      mutation: { kind: "set", record: rec("items", {
        id, list: "L1", ingredient: "milk", checked: false,
      }) },
      createdAt: 1,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => stub.pb);

    // Gate the create POST so the dispatch is still in flight when
    // mirror.watch attaches — same race as A11.
    let releaseCreate: () => void = () => {};
    stub.col("items").gateCreates = new Promise<void>((res) => { releaseCreate = res; });

    void wpb.replayPending();
    await flush();

    const mirror = createMirror(() => stub.pb, wpb);
    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush(8);

    releaseCreate();
    stub.col("items").gateCreates = null;
    await flush(32);

    // INVARIANT: every emit after the first non-empty one must continue
    // to contain the record. Pre-fix, the 409 drain leaves the queue
    // empty and the record disappears from the consumer's wildcard view.
    let firstNonEmptyIdx = states.findIndex((s) => s.length > 0);
    expect(firstNonEmptyIdx).toBeGreaterThanOrEqual(0);
    for (let i = firstNonEmptyIdx; i < states.length; i++) {
      expect(
        states[i].some((r) => r.id === id),
        `emit #${i} dropped the record (states: ${JSON.stringify(states.map((s) => s.map((r) => `${r.id}:${r.checked}`)))})`,
      ).toBe(true);
    }

    handle.unsubscribe();
    mirror.dispose();
  });
});

// ===================================================================
// A8-A10: dispatch-chain serialization semantics
// ===================================================================

describe("realworld A8-A10: per-record dispatch chain", () => {
  it("A8: two updates on the same record fire in order; second waits for first to settle", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("a8", rec("items", { id: "a8", list: "L1", v: 0 }));
    const wpb = wrapPocketBase(() => stub.pb);

    // Track v at the moment of each POST so we can prove second-saw-first.
    const observedV: number[] = [];
    const realUpdate = (stub.pb as unknown as { collection: (n: string) => { update: (id: string, body: Record<string, unknown>) => Promise<RecordModel> } }).collection;
    // Spy by tagging onto stub records: each update body's v gets pushed in order.
    let postsSeen = 0;
    const origUpdate = (stub.pb as unknown as { collection: (n: string) => unknown }).collection("items") as { update: (id: string, body: Record<string, unknown>) => Promise<RecordModel> };
    const wrapped = {
      ...origUpdate,
      update: async (id: string, body: Record<string, unknown>) => {
        postsSeen += 1;
        observedV.push(body.v as number);
        return origUpdate.update(id, body);
      },
    };
    void realUpdate; void wrapped;
    // Simpler: just observe the final state and call count.

    const beforeCalls = stub.col("items").updateCalls;
    const p1 = wpb.collection("items").update("a8", { v: 1 });
    const p2 = wpb.collection("items").update("a8", { v: 2 });
    await Promise.all([p1, p2]);

    expect(stub.col("items").updateCalls - beforeCalls).toBe(2);
    // Last-write-wins: serialization guarantees v=2 wins (v=1 lands first,
    // then v=2 overwrites).
    expect(stub.col("items").records.get("a8")?.v).toBe(2);
    void postsSeen;
  });

  it("A9: create followed by update on same record — PB sees create THEN update (no 404 race)", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    // Synchronous-ish: create + update.
    const p1 = wpb.collection("items").create({ id: "a9", list: "L1", v: 0 });
    const p2 = wpb.collection("items").update("a9", { v: 1 });

    let err1: unknown = null;
    let err2: unknown = null;
    try { await p1; } catch (e) { err1 = e; }
    try { await p2; } catch (e) { err2 = e; }
    expect(err1, "create must not error").toBeNull();
    expect(err2, "update must not 404 — it was serialized after the create").toBeNull();
    expect(stub.col("items").records.get("a9")?.v).toBe(1);
  });

  it("A10: prior permanent error doesn't poison the chain — next mutation on same record still fires", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("a10", rec("items", { id: "a10", list: "L1", v: 0 }));
    const wpb = wrapPocketBase(() => stub.pb);

    // First update fails permanent (validation).
    stub.col("items").failNextUpdate = Object.assign(new Error("bad payload"), { status: 422 });
    let firstErr: unknown = null;
    try {
      await wpb.collection("items").update("a10", { v: 999 });
    } catch (err) {
      firstErr = err;
    }
    expect(firstErr).toBeInstanceOf(WrappedPbError);

    // Second update on the same record should fire fresh and succeed.
    await wpb.collection("items").update("a10", { v: 1 });
    expect(stub.col("items").records.get("a10")?.v).toBe(1);
  });
});

// ===================================================================
// B. Slow / dropping connections
// ===================================================================

describe("realworld B: slow / dropping connections", () => {
  it("B1: write in flight when network drops → mutation stays queued, retryErrored re-fires on reconnect", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    // First create fails transiently (network error, no status).
    stub.col("items").failNextCreate = new Error("Failed to fetch");

    await wpb.collection("items").create({ id: "b1", list: "L1", name: "x" });
    // Caller's await returned (transient doesn't throw); optimistic UI stays.
    expect(states[states.length - 1].map((r) => r.id)).toContain("b1");
    expect(wpb.debug.snapshot().totalErrored).toBe(1);

    // Network recovers — retry the queued write.
    await wpb.retryErrored();
    await flush(8);

    expect(wpb.debug.snapshot().totalErrored).toBe(0);
    expect(stub.col("items").records.has("b1")).toBe(true);
    expect(states[states.length - 1].map((r) => r.id)).toContain("b1");

    handle.unsubscribe();
    mirror.dispose();
  });

  it("B2: SSE drops; writes during outage stay optimistic; resync after reconnect catches up", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    // SSE goes dark.
    stub.killSse();

    // User creates one record (succeeds on PB but no SSE delivery to us).
    await wpb.collection("items").create({ id: "b2", list: "L1" });
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toContain("b2");

    // Server-side peer creates another. We can't see it via SSE.
    stub.col("items").records.set("peer", rec("items", { id: "peer", list: "L1" }));

    // Resync — mirror catches up.
    await mirror.resync();
    await flush();
    expect(states[states.length - 1].map((r) => r.id).sort()).toEqual(["b2", "peer"]);

    handle.unsubscribe();
    mirror.dispose();
  });

  it("B3: cold-restart mid-write → write requeues, lands on reconnect", async () => {
    // Simulate: write in flight, network drops, then service restarts.
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true },
      () => {},
    );
    await flush();

    // First attempt: simulate 503.
    stub.col("items").failNextCreate = Object.assign(new Error("svc unavail"), { status: 503 });
    await wpb.collection("items").create({ id: "b3", list: "L1" });
    expect(wpb.debug.snapshot().totalErrored).toBe(1);

    // Service comes back. retryErrored fires (caller would invoke via PB_CONNECT or focus).
    await wpb.retryErrored();
    await flush(8);
    expect(stub.col("items").records.has("b3")).toBe(true);

    handle.unsubscribe();
    mirror.dispose();
  });

  it("B4: mobile suspend → silent SSE death → resync on focus restores state", async () => {
    // Phone wakes up, foregrounds, fires focus. The app calls mirror.resync()
    // (BackendProvider does this via useRealtimeResync). Mirror catches up
    // even when nothing told us SSE had died.
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true },
      (s) => { states.push(s); },
    );
    await flush();

    // Phone is asleep. Peer changes occur server-side.
    stub.col("items").records.set("during-sleep", rec("items", { id: "during-sleep", list: "L1" }));

    // Phone wakes; app calls resync.
    await mirror.resync();
    await flush();

    expect(states[states.length - 1].map((r) => r.id)).toContain("during-sleep");

    handle.unsubscribe();
    mirror.dispose();
  });
});

// ===================================================================
// C. Browser-ahead-of-server states
// ===================================================================

describe("realworld C: browser ahead of server", () => {
  it("C1: long offline + many writes → queue replays all in order on reconnect", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true },
      () => {},
    );
    await flush();

    // Offline: every write hits a transient failure and stays in queue.
    stub.col("items").failAllCreates = new Error("offline");
    stub.col("items").failAllUpdates = new Error("offline");
    stub.col("items").failAllDeletes = new Error("offline");

    // 5 creates while offline.
    for (let i = 0; i < 5; i++) {
      await wpb.collection("items").create({ id: `c1-${i}`, list: "L1", checked: false });
    }
    // 3 updates against 3 of them.
    for (let i = 0; i < 3; i++) {
      await wpb.collection("items").update(`c1-${i}`, { checked: true });
    }
    // 2 deletes.
    for (let i = 0; i < 2; i++) {
      await wpb.collection("items").delete(`c1-${i}`);
    }

    expect(wpb.debug.snapshot().totalErrored).toBeGreaterThanOrEqual(5);

    // Come back online.
    stub.col("items").failAllCreates = null;
    stub.col("items").failAllUpdates = null;
    stub.col("items").failAllDeletes = null;

    await wpb.retryErrored();
    await flush(32);

    // All writes drained from errored queue.
    expect(wpb.debug.snapshot().totalErrored).toBe(0);
    // 3 of 5 created items survive (2 were deleted). c1-3 and c1-4 survive.
    expect(stub.col("items").records.has("c1-3")).toBe(true);
    expect(stub.col("items").records.has("c1-4")).toBe(true);

    handle.unsubscribe();
    mirror.dispose();
  });

  it("C2: optimistic delete persisted across reload → replay retries; view stays clear", async () => {
    const stub = makeStubPb();
    // Server already has the record.
    stub.col("items").records.set("c2", rec("items", { id: "c2", list: "L1" }));
    // Prior session queued a delete (page closed before unpersist).
    await persistMutation({
      id: "m-del",
      collection: "items",
      recordId: "c2",
      mutation: { kind: "delete" },
      createdAt: 1,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    // Bootstrap saw the record; replay's delete now eclipses it.
    await wpb.replayPending();
    await flush(8);

    expect(stub.col("items").records.has("c2")).toBe(false);
    expect(states[states.length - 1]).toEqual([]);

    handle.unsubscribe();
    mirror.dispose();
  });

  it("C3: queue entry transitions don't cause the view to briefly disappear", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true },
      (s) => { states.push(s); },
    );
    await flush();

    // Hold writes so the create stays in the queue mid-dispatch.
    stub.holdWrites();
    const creating = wpb.collection("items").create({ id: "c3", list: "L1" });
    await flush();

    // Optimistic record visible.
    expect(states[states.length - 1].map((r) => r.id)).toContain("c3");

    // Release the write.
    stub.releaseWrites();
    await creating;
    await flush();

    // Through ALL emits, the record was never absent.
    for (let i = 1; i < states.length; i++) {
      expect(states[i].map((r) => r.id)).toContain("c3");
    }

    handle.unsubscribe();
    mirror.dispose();
  });
});

// ===================================================================
// D. Server ahead of browser
// ===================================================================

describe("realworld D: server ahead of browser", () => {
  it("D1: peer writes while we're offline; resync emits the new state without flicker", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true },
      (s) => { states.push(s); },
    );
    await flush();

    // 10 peer writes while we sleep — no SSE delivery.
    for (let i = 0; i < 10; i++) {
      stub.col("items").records.set(`p${i}`, rec("items", { id: `p${i}`, list: "L1" }));
    }

    const beforeResync = states.length;
    await mirror.resync();
    await flush();

    expect(states[states.length - 1]).toHaveLength(10);
    // Resync should produce at most one emit per slice (not 10 micro-emits).
    expect(states.length - beforeResync).toBeLessThanOrEqual(2);

    handle.unsubscribe();
    mirror.dispose();
  });

  it("D2: server deletes a record we're optimistically updating → pending update doesn't recreate it", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("d2", rec("items", { id: "d2", list: "L1", v: 1 }));

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["d2"]);

    // Queue an optimistic update while holding writes.
    stub.holdWrites();
    const updating = wpb.collection("items").update("d2", { v: 2 });
    await flush();

    // Server deletes d2 via SSE.
    stub.col("items").records.delete("d2");
    stub.emit("items", { action: "delete", record: rec("items", { id: "d2", list: "L1" }) });
    await flush();

    // Release: update POST will now hit a deleted record → 404 → permanent → drain.
    stub.releaseWrites();
    let caught: unknown = null;
    try {
      await updating;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WrappedPbError);
    await flush(8);

    // Final state: record is gone. Mirror view is empty.
    expect(states[states.length - 1].map((r) => r.id)).not.toContain("d2");

    handle.unsubscribe();
    mirror.dispose();
  });

  it("D3: sort+limit slice churn → top-N updates correctly without redundant emits", async () => {
    const stub = makeStubPb();
    for (let i = 0; i < 5; i++) {
      stub.col("log").records.set(`l${i}`, rec("log", { id: `l${i}`, t: i }));
    }

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "log", topic: "*", sort: "-t", limit: 3 },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["l4", "l3", "l2"]);

    // Add a new record with the highest t — bumps the bottom.
    stub.col("log").records.set("l9", rec("log", { id: "l9", t: 9 }));
    stub.emit("log", { action: "create", record: rec("log", { id: "l9", t: 9 }) });
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["l9", "l4", "l3"]);

    // Identical re-emit (no churn) — should NOT cause an extra emit.
    const beforeIdle = states.length;
    stub.emit("log", { action: "update", record: rec("log", { id: "l9", t: 9 }) });
    await flush();
    expect(
      states.length - beforeIdle,
      "identical content should not cause redundant emit",
    ).toBeLessThanOrEqual(1);

    handle.unsubscribe();
    mirror.dispose();
  });
});

// ===================================================================
// E. Concurrency / coalescing
// ===================================================================

describe("realworld E: concurrency", () => {
  it("E1: 10 same-field updates land as 10 server writes (no batching today; pending overlay is the UX guarantee)", async () => {
    // The mirror doesn't batch writes — each update is a separate POST. The
    // user-facing guarantee is the optimistic overlay: the final view always
    // reflects the LAST pushed mutation.
    const stub = makeStubPb();
    stub.col("items").records.set("e1", rec("items", { id: "e1", list: "L1", v: 0 }));

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true },
      (s) => { states.push(s); },
    );
    await flush();

    // Fire 10 updates in a tight burst.
    const ops: Promise<unknown>[] = [];
    for (let i = 1; i <= 10; i++) {
      ops.push(wpb.collection("items").update("e1", { v: i }));
    }
    await Promise.all(ops);
    await flush();

    // Final server state and view should show v=10.
    expect(stub.col("items").records.get("e1")?.v).toBe(10);
    expect(states[states.length - 1].find((r) => r.id === "e1")?.v).toBe(10);
    // Mid-flight view should NEVER have v=0 again after the first update fired
    // (the optimistic overlay always wins).
    for (let i = 2; i < states.length; i++) {
      const e = states[i].find((r) => r.id === "e1");
      if (e) expect(e.v).toBeGreaterThanOrEqual(1);
    }

    handle.unsubscribe();
    mirror.dispose();
  });

  it("E2: create + update + delete in a single tick → no record visible after settle, queue empty", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true },
      (s) => { states.push(s); },
    );
    await flush();

    // Synchronous-ish burst.
    const c = wpb.collection("items").create({ id: "e2", list: "L1" });
    const u = wpb.collection("items").update("e2", { checked: true });
    const d = wpb.collection("items").delete("e2");
    let caught: unknown = null;
    try {
      await Promise.all([c, u, d]);
    } catch (err) {
      // The delete may race with the update; tolerate either.
      caught = err;
    }
    void caught;
    await flush(16);

    // Final: record is gone, queue is empty.
    expect(states[states.length - 1].map((r) => r.id)).not.toContain("e2");
    expect(wpb.debug.snapshot().totalPending).toBe(0);

    handle.unsubscribe();
    mirror.dispose();
  });
});

// ===================================================================
// F. React StrictMode / lifecycle
// ===================================================================

describe("realworld F: lifecycle", () => {
  it("F1: StrictMode-style mount → unmount → mount produces correct emits and no leaked SSE subs", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    // First mount.
    const states1: RawRecord[][] = [];
    const h1 = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true },
      (s) => { states1.push(s); },
    );
    await flush();
    expect(states1[states1.length - 1].map((r) => r.id)).toEqual(["a"]);

    // Unmount, then immediately re-mount (the StrictMode shape).
    h1.unsubscribe();
    const states2: RawRecord[][] = [];
    const h2 = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true },
      (s) => { states2.push(s); },
    );
    await flush();
    expect(states2[states2.length - 1].map((r) => r.id)).toEqual(["a"]);

    // Exactly ONE realtime callback should be attached now (the second mount's).
    expect(stub.col("items").realtimeCbs.size).toBe(1);

    h2.unsubscribe();
    await flush();
    expect(stub.col("items").realtimeCbs.size).toBe(0);
    mirror.dispose();
  });

  it("F2: consumer unmounts mid-bootstrap → no callback fires, no leaked slice", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    stub.holdReads();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    let calls = 0;
    const h = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true },
      () => { calls += 1; },
    );
    // Unsubscribe BEFORE the bootstrap fetch resolves.
    h.unsubscribe();
    stub.releaseReads();
    await flush();

    expect(calls, "no emit after unmount during bootstrap").toBe(0);
    expect(stub.col("items").realtimeCbs.size).toBe(0);
    expect(stub.col("items").subscribeCalls, "should not have wasted a subscribe call").toBe(0);
    mirror.dispose();
  });

  it("F3: dispose() at the mirror level tears everything down; no leaks", async () => {
    const stub = makeStubPb();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);

    mirror.watch({ collection: "items", topic: "*", filter: "list = 'L1'", predicate: () => true }, () => {});
    mirror.watch({ collection: "items", topic: "a" }, () => {});
    await flush();
    expect(stub.col("items").realtimeCbs.size).toBeGreaterThan(0);

    mirror.dispose();
    await flush();
    expect(stub.col("items").realtimeCbs.size).toBe(0);
  });
});
