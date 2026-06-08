/**
 * PBMirror unit tests — fast, against a stub PocketBase.
 *
 * Test plan (30 named scenarios from the design brief). Each is a named `it`
 * block so the test report reads like a behavior spec sheet.
 *
 * Happy path .......................... (1) - (6)
 * Cancellation / race conditions ...... (7) - (11)
 * Reconciliation edge cases ........... (12) - (21)
 * Optimistic overlay correctness ...... (22) - (26)
 * Lifecycle ........................... (27) - (29)
 * SDK quirk defense ................... (30)
 */
import { describe, it, expect, beforeEach } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase } from "./index";
import { createMirror, type RawRecord } from "./mirror";
import { clearAllMutations } from "./persistence";

// ---- Stub PocketBase ----

type RealtimeCb = (e: { action: string; record: RecordModel }) => void;

interface StubCollection {
  records: Map<string, RecordModel>;
  realtimeCbs: Set<RealtimeCb>;
  /** Total subscribe(...) invocations. Lets tests assert SSE coalescing
   *  (one underlying subscribe regardless of how many local watches). */
  subscribeCalls: number;
  /** Total getFullList(...) / getList(...) invocations. */
  fetchCalls: number;
  /** Gate getOne/getFullList/getList to test cancel-mid-await. */
  gateReads: Promise<void> | null;
  /** When non-undefined, the next read throws this. */
  failNextRead: unknown;
  /** When non-undefined, the next create throws this. */
  failNextCreate: unknown;
}

interface StubHandle {
  pb: PocketBase;
  /** Push an SSE event to every realtime cb registered for `col`. */
  emit: (col: string, e: { action: string; record: RecordModel }) => void;
  /** Get / create the per-collection stub state. */
  col: (n: string) => StubCollection;
  /** Hold all pending and future reads; release with `release()`. */
  hold: () => void;
  release: () => void;
  /** Simulate the PB SDK detecting a realtime drop then auto-reconnecting:
   *  fires onDisconnect(activeSubs) then every PB_CONNECT subscriber. */
  dropAndReconnect: (activeSubs?: string[]) => void;
  /** Fire PB_CONNECT to every subscriber WITHOUT a preceding disconnect —
   *  models the very first connect after the initial subscribe. */
  fireConnect: () => void;
  /** Number of live PB_CONNECT subscribers (asserts dispose tore them down). */
  pbConnectListenerCount: () => number;
}

function makeStubPb(): StubHandle {
  const cols = new Map<string, StubCollection>();
  let releaseAll: () => void = () => {};
  let held = false;
  // Realtime lifecycle plumbing. The mirror's reconnect-resync hook sets
  // `onDisconnect` and subscribes to "PB_CONNECT"; these collections let a
  // test drive a drop+reconnect deterministically.
  const realtime: {
    onDisconnect?: (activeSubs: string[]) => void;
    pbConnectCbs: Set<() => void>;
  } = { onDisconnect: undefined, pbConnectCbs: new Set() };
  const get = (n: string): StubCollection => {
    let c = cols.get(n);
    if (!c) {
      c = {
        records: new Map(),
        realtimeCbs: new Set(),
        subscribeCalls: 0,
        fetchCalls: 0,
        gateReads: null,
        failNextRead: undefined,
        failNextCreate: undefined,
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
      get onDisconnect() { return realtime.onDisconnect; },
      set onDisconnect(fn: ((activeSubs: string[]) => void) | undefined) { realtime.onDisconnect = fn; },
      isConnected: true,
      async subscribe(topic: string, cb?: () => void) {
        if (topic === "PB_CONNECT" && cb) {
          realtime.pbConnectCbs.add(cb);
          return async () => { realtime.pbConnectCbs.delete(cb); };
        }
        return async () => {};
      },
    },
    collection: (name: string) => {
      const c = get(name);
      const applyFilter = (r: RecordModel, filter?: string): boolean => {
        if (!filter) return true;
        const m = filter.match(/^(\w+)\s*=\s*'([^']*)'$/);
        if (m) return (r as unknown as Record<string, unknown>)[m[1]] === m[2];
        const m2 = filter.match(/^(\w+)\s*=\s*(\S+)$/);
        if (m2) return String((r as unknown as Record<string, unknown>)[m2[1]]) === m2[2];
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
            else if (av < bv) cmp = -1;
            else if (av > bv) cmp = 1;
            else cmp = 0;
            if (cmp !== 0) return desc ? -cmp : cmp;
          }
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
      };
      return {
        async create(body: Record<string, unknown>): Promise<RecordModel> {
          if (c.failNextCreate !== undefined) {
            const err = c.failNextCreate;
            c.failNextCreate = undefined;
            throw err;
          }
          const id = (body.id as string) ?? `id-${Math.random().toString(36).slice(2, 17)}`;
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
          c.subscribeCalls += 1;
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
          const sorted = applySort(all, opts?.sort);
          return { items: sorted.slice(0, perPage) };
        },
        async getFirstListItem(): Promise<RecordModel> {
          throw Object.assign(new Error("not found"), { status: 404 });
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
    hold() {
      held = true;
      const p = new Promise<void>((res) => { releaseAll = res; });
      for (const c of cols.values()) c.gateReads = p;
    },
    release() {
      if (!held) return;
      releaseAll();
      for (const c of cols.values()) c.gateReads = null;
      held = false;
    },
    dropAndReconnect(activeSubs: string[] = ["items"]) {
      realtime.onDisconnect?.(activeSubs);
      for (const cb of Array.from(realtime.pbConnectCbs)) cb();
    },
    fireConnect() {
      for (const cb of Array.from(realtime.pbConnectCbs)) cb();
    },
    pbConnectListenerCount() {
      return realtime.pbConnectCbs.size;
    },
  };
}

/** Build a Record-like object for tests. */
function rec(name: string, fields: Record<string, unknown> & { id: string }): RecordModel {
  return {
    collectionId: name,
    collectionName: name,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    ...fields,
  } as unknown as RecordModel;
}

/** Microtask drain — enough to settle several await chains. */
async function flush(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Build a configured mirror + stub + wpb. */
function setup(): {
  stub: StubHandle;
  mirror: ReturnType<typeof createMirror>;
  wpb: ReturnType<typeof wrapPocketBase>;
} {
  const stub = makeStubPb();
  const wpb = wrapPocketBase(() => stub.pb);
  const mirror = createMirror(() => stub.pb, wpb);
  return { stub, mirror, wpb };
}

beforeEach(async () => {
  await clearAllMutations();
});

// =====================================================================
// Happy path (1) - (6)
// =====================================================================

describe("PBMirror: happy path", () => {
  it("(1) single-record watch: subscribe → first emit → update → second emit → unsubscribe", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", name: "v1" }));

    const states: RawRecord[][] = [];
    const handle = mirror.watch({ collection: "items", topic: "a" }, (s) => { states.push(s); });
    await flush();
    expect(states).toHaveLength(1);
    expect(states[0]).toEqual([expect.objectContaining({ id: "a", name: "v1" })]);

    stub.emit("items", { action: "update", record: rec("items", { id: "a", name: "v2" }) });
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[states.length - 1][0].name).toBe("v2");

    handle.unsubscribe();
  });

  it("(1b) single-record watch initial 404: first emit []", async () => {
    const { mirror } = setup();
    const states: RawRecord[][] = [];
    mirror.watch({ collection: "items", topic: "missing" }, (s) => { states.push(s); });
    await flush();
    expect(states).toEqual([[]]);
  });

  it("(2) wildcard + filter: initial filtered list, then create/update/delete events", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    stub.col("items").records.set("b", rec("items", { id: "b", list: "L2" }));

    const states: RawRecord[][] = [];
    mirror.watch(
      {
        collection: "items",
        topic: "*",
        filter: "list = 'L1'",
        predicate: (r) => r.list === "L1",
      },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states).toHaveLength(1);
    expect(states[0].map((r) => r.id)).toEqual(["a"]);

    // Create new matching record (server side)
    stub.col("items").records.set("c", rec("items", { id: "c", list: "L1" }));
    stub.emit("items", { action: "create", record: rec("items", { id: "c", list: "L1" }) });
    await flush();
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[states.length - 1].map((r) => r.id).sort()).toEqual(["a", "c"]);

    // Update matching record
    stub.emit("items", { action: "update", record: rec("items", { id: "a", list: "L1", note: "x" }) });
    await flush();
    const lastWithNote = states[states.length - 1].find((r) => r.id === "a");
    expect(lastWithNote?.note).toBe("x");

    // Delete matching record
    stub.emit("items", { action: "delete", record: rec("items", { id: "a", list: "L1" }) });
    await flush();
    expect(states[states.length - 1].map((r) => r.id).sort()).toEqual(["c"]);
  });

  it("(3) sort + limit: top-N is server-side; new record that ranks higher displaces #N", async () => {
    const { stub, mirror } = setup();
    // Seed 3 records — limit=2 should drop the oldest.
    stub.col("log").records.set("a", rec("log", { id: "a", t: 3 }));
    stub.col("log").records.set("b", rec("log", { id: "b", t: 2 }));
    stub.col("log").records.set("c", rec("log", { id: "c", t: 1 }));

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "log", topic: "*", sort: "-t", limit: 2 },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a", "b"]);

    // Server gets a record that should rank #1, displacing the bottom.
    stub.col("log").records.set("d", rec("log", { id: "d", t: 4 }));
    stub.emit("log", { action: "create", record: rec("log", { id: "d", t: 4 }) });
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["d", "a"]);
  });

  it("(4) optimistic overlay: local create appears BEFORE server ack", async () => {
    const { stub, wpb, mirror } = setup();

    const states: RawRecord[][] = [];
    mirror.watch(
      {
        collection: "items",
        topic: "*",
        filter: "list = 'L1'",
        predicate: (r) => r.list === "L1",
      },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1]).toHaveLength(0);

    // Hold the create's network call so we can observe the pre-ack state.
    stub.hold();
    void wpb.collection("items").create({ id: "z", list: "L1", name: "optimistic" });
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toContain("z");

    stub.release();
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toContain("z");
  });

  it("(5) multiple consumers, same spec: both get same state; both unsub tears down SSE", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const aStates: RawRecord[][] = [];
    const bStates: RawRecord[][] = [];
    const h1 = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { aStates.push(s); },
    );
    const h2 = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { bStates.push(s); },
    );
    await flush();
    expect(aStates[aStates.length - 1].map((r) => r.id)).toEqual(["a"]);
    expect(bStates[bStates.length - 1].map((r) => r.id)).toEqual(["a"]);
    // SSE coalesced — only ONE underlying pb.subscribe call per slice.
    expect(stub.col("items").subscribeCalls).toBe(1);

    h1.unsubscribe();
    await flush();
    expect(stub.col("items").realtimeCbs.size).toBe(1);

    h2.unsubscribe();
    await flush();
    expect(stub.col("items").realtimeCbs.size).toBe(0);
  });

  it("(6) coalesced underlying SSE: many watches → at most one PB realtime CB per collection", async () => {
    const { stub, mirror } = setup();

    mirror.watch({ collection: "A", topic: "*", filter: "v = '1'", predicate: () => true }, () => {});
    mirror.watch({ collection: "A", topic: "*", filter: "v = '2'", predicate: () => true }, () => {});
    mirror.watch({ collection: "B", topic: "*", filter: "w = '1'", predicate: () => true }, () => {});
    await flush();

    // Realtime callbacks per collection: the mirror should share ONE PB SSE
    // listener per collection regardless of slice count.
    expect(stub.col("A").realtimeCbs.size).toBeLessThanOrEqual(1);
    expect(stub.col("B").realtimeCbs.size).toBeLessThanOrEqual(1);
  });
});

// =====================================================================
// Cancellation / race conditions (7) - (11)
// =====================================================================

describe("PBMirror: cancellation / races", () => {
  it("(7) cancel BEFORE initial state arrives: no callback fires; no SSE if last-consumer", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    stub.hold();

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    handle.unsubscribe();
    stub.release();
    await flush();

    expect(states, "no state should be delivered to a cancelled watch").toHaveLength(0);
    expect(stub.col("items").realtimeCbs.size, "no leaked realtime subscriber").toBe(0);
    expect(stub.col("items").subscribeCalls, "no wasted subscribe call").toBe(0);
  });

  it("(8) cancel during SSE event processing: no further emits to cancelled handle", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const states: RawRecord[][] = [];
    let handle: { unsubscribe: () => void } | null = null;
    handle = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => {
        states.push(s);
        if (states.length === 1) handle?.unsubscribe();
      },
    );
    await flush();

    // Fire a server event; should not deliver to the cancelled callback.
    stub.emit("items", { action: "create", record: rec("items", { id: "b", list: "L1" }) });
    await flush();
    expect(states, "no emit after self-unsubscribe").toHaveLength(1);
  });

  it("(9) cancel BETWEEN initial fetch and SSE subscribe: no pb.subscribe call", async () => {
    // Same shape as commit 60c33ca's `subscribeToCollectionReload` race.
    const { stub, mirror } = setup();
    stub.col("log").records.set("a", rec("log", { id: "a", t: 1, list: "L1" }));

    stub.hold();
    const handle = mirror.watch(
      { collection: "log", topic: "*", filter: "list = 'L1'", sort: "-t", limit: 10, predicate: (r) => r.list === "L1" },
      () => {},
    );
    handle.unsubscribe();
    stub.release();
    await flush();

    expect(stub.col("log").subscribeCalls).toBe(0);
    expect(stub.col("log").realtimeCbs.size).toBe(0);
  });

  it("(10) repeated mount/unmount churn: 100 cycles → no leaks", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    for (let i = 0; i < 100; i++) {
      const handle = mirror.watch(
        { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
        () => {},
      );
      if (i % 3 === 0) handle.unsubscribe();
      else { await flush(1); handle.unsubscribe(); }
    }
    await flush();

    expect(stub.col("items").realtimeCbs.size).toBe(0);
  });

  it("(11) two watches, unsubscribe first while second still active: only first stops; SSE stays up", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const a: RawRecord[][] = [];
    const b: RawRecord[][] = [];
    const h1 = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { a.push(s); },
    );
    const h2 = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { b.push(s); },
    );
    await flush();

    const aLenBefore = a.length;
    h1.unsubscribe();

    stub.emit("items", { action: "create", record: rec("items", { id: "z", list: "L1" }) });
    await flush();

    expect(a.length, "h1 should not receive any further state").toBe(aLenBefore);
    expect(b[b.length - 1].map((r) => r.id)).toContain("z");
    expect(stub.col("items").realtimeCbs.size).toBe(1);

    h2.unsubscribe();
  });
});

// =====================================================================
// Reconciliation edge cases (12) - (21)
// =====================================================================

describe("PBMirror: reconciliation", () => {
  it("(12) initial filter matches zero records: first emit []", async () => {
    const { mirror } = setup();
    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1]).toEqual([]);
  });

  it("(13) record updated to no longer match filter is excluded from state", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);

    stub.emit("items", { action: "update", record: rec("items", { id: "a", list: "L2" }) });
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual([]);
  });

  it("(14) record updated FROM non-matching to matching is included", async () => {
    const { stub, mirror } = setup();

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1]).toEqual([]);

    stub.emit("items", { action: "update", record: rec("items", { id: "a", list: "L1" }) });
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);
  });

  it("(15) server filter + client predicate combine — predicate narrows further", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1", important: true }));
    stub.col("items").records.set("b", rec("items", { id: "b", list: "L1", important: false }));

    const states: RawRecord[][] = [];
    mirror.watch(
      {
        collection: "items",
        topic: "*",
        filter: "list = 'L1'",
        predicate: (r) => r.list === "L1" && r.important === true,
      },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);
  });

  it("(16) delete event for an id we never saw produces no spurious emit", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    const initialEmits = states.length;

    stub.emit("items", { action: "delete", record: rec("items", { id: "ghost", list: "L2" }) });
    await flush();

    expect(states.length, "no extra emit for an unknown-record delete").toBe(initialEmits);
  });

  it("(17) out-of-order SSE: update before create — final state correct", async () => {
    const { stub, mirror } = setup();
    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    stub.emit("items", { action: "update", record: rec("items", { id: "a", list: "L1", v: 1 }) });
    stub.emit("items", { action: "create", record: rec("items", { id: "a", list: "L1", v: 1 }) });
    await flush();

    const final = states[states.length - 1];
    expect(final.map((r) => r.id)).toEqual(["a"]);
    expect(final[0].v).toBe(1);
  });

  it("(18) server update that's a no-op vs prior state: NO emit", async () => {
    const { stub, mirror } = setup();
    const r1 = rec("items", { id: "a", list: "L1", v: 1 });
    stub.col("items").records.set("a", r1);

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    const initial = states.length;

    stub.emit("items", { action: "update", record: r1 });
    await flush();
    expect(states.length, "no emit for identical server snapshot").toBe(initial);
  });

  it("(19) sort+limit edge: ties at boundary deterministic (id-tiebreaker)", async () => {
    const { stub, mirror } = setup();
    stub.col("log").records.set("a", rec("log", { id: "a", t: 1 }));
    stub.col("log").records.set("b", rec("log", { id: "b", t: 1 }));

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "log", topic: "*", sort: "-t", limit: 1 },
      (s) => { states.push(s); },
    );
    await flush();

    const first = states[states.length - 1].map((r) => r.id);
    stub.emit("log", { action: "update", record: rec("log", { id: "a", t: 1 }) });
    await flush();
    const second = states[states.length - 1].map((r) => r.id);
    expect(second).toEqual(first);
  });

  it("(20) single-record watch where record gets deleted server-side: emits []", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", v: 1 }));

    const states: RawRecord[][] = [];
    mirror.watch({ collection: "items", topic: "a" }, (s) => { states.push(s); });
    await flush();
    expect(states[states.length - 1]).toHaveLength(1);

    stub.emit("items", { action: "delete", record: rec("items", { id: "a", v: 1 }) });
    await flush();
    expect(states[states.length - 1]).toEqual([]);
  });

  it("(21) single-record watch on initially-missing record: first emit []; later create emits", async () => {
    const { stub, mirror } = setup();

    const states: RawRecord[][] = [];
    mirror.watch({ collection: "items", topic: "later" }, (s) => { states.push(s); });
    await flush();
    expect(states[states.length - 1]).toEqual([]);

    stub.emit("items", { action: "create", record: rec("items", { id: "later", v: 7 }) });
    await flush();
    expect(states[states.length - 1]).toHaveLength(1);
    expect(states[states.length - 1][0].id).toBe("later");
  });
});

// =====================================================================
// Optimistic overlay correctness (22) - (26)
// =====================================================================

describe("PBMirror: optimistic overlay", () => {
  it("(22) optimistic create: appears in state before server ack; persists after", async () => {
    const { stub, wpb, mirror } = setup();

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    stub.hold();
    void wpb.collection("items").create({ id: "z", list: "L1", v: 1 });
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toContain("z");

    stub.release();
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toContain("z");
  });

  it("(23) optimistic update on record IN state: state reflects update before ack", async () => {
    const { stub, wpb, mirror } = setup();

    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1", v: 1 }));

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1][0].v).toBe(1);

    stub.hold();
    void wpb.collection("items").update("a", { v: 2 });
    await flush();
    const updated = states[states.length - 1].find((r) => r.id === "a");
    expect(updated?.v).toBe(2);

    stub.release();
    await flush();
  });

  it("(24) optimistic update on record NEVER seeded: shows up in state (fixes a known wpb gap)", async () => {
    const { stub, wpb, mirror } = setup();

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1]).toEqual([]);

    // Seed the server stub so the eventual ack succeeds.
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1", v: 0 }));
    // But the mirror has never seen `a` (no initial fetch returned it).
    stub.hold();
    void wpb.collection("items").update("a", { list: "L1", v: 1, note: "optimistic" });
    await flush();
    const found = states[states.length - 1].find((r) => r.id === "a");
    expect(
      found,
      "optimistic update on never-seeded record must appear in mirror state",
    ).toBeDefined();
    expect(found?.note).toBe("optimistic");
    stub.release();
    await flush();
  });

  it("(25) optimistic delete: state excludes record before ack; stays excluded after", async () => {
    const { stub, wpb, mirror } = setup();

    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);

    stub.hold();
    void wpb.collection("items").delete("a");
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual([]);

    stub.release();
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual([]);
  });

  it("(26) optimistic write that ultimately fails (permanent 403): rollback in state", async () => {
    const { stub, wpb, mirror } = setup();

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    stub.col("items").failNextCreate = Object.assign(new Error("forbidden"), { status: 403 });

    let rejected = false;
    try {
      await wpb.collection("items").create({ id: "z", list: "L1" });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    await flush();

    expect(states[states.length - 1].map((r) => r.id)).not.toContain("z");
  });
});

// =====================================================================
// Lifecycle (27) - (29)
// =====================================================================

describe("PBMirror: lifecycle", () => {
  it("(27) all watches unsubscribed → underlying SSE torn down", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const h = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      () => {},
    );
    await flush();
    expect(stub.col("items").realtimeCbs.size).toBe(1);

    h.unsubscribe();
    await flush();
    expect(stub.col("items").realtimeCbs.size).toBe(0);
  });

  it("(28) subscribe after teardown: SSE re-established cleanly", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const h1 = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      () => {},
    );
    await flush();
    expect(stub.col("items").realtimeCbs.size).toBe(1);

    h1.unsubscribe();
    await flush();
    expect(stub.col("items").realtimeCbs.size).toBe(0);

    const states: RawRecord[][] = [];
    const h2 = mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    expect(stub.col("items").realtimeCbs.size).toBe(1);
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);

    h2.unsubscribe();
  });

  it("(29) dispose(): all watches torn down; callbacks become no-ops", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    const initial = states.length;

    mirror.dispose();
    await flush();

    stub.emit("items", { action: "create", record: rec("items", { id: "b", list: "L1" }) });
    await flush();

    expect(states.length, "no emits after dispose").toBe(initial);
    expect(stub.col("items").realtimeCbs.size).toBe(0);
  });
});

// =====================================================================
// SDK quirk defense (30)
// =====================================================================

describe("PBMirror: observability", () => {
  it("surfaces a bootstrap-error event when the initial fetch fails (non-404)", async () => {
    const { stub, mirror, wpb } = setup();
    // Filtered "*" watches use getFullList — fail it with a transient.
    stub.col("items").failNextRead = Object.assign(new Error("auth blip"), { status: 401 });

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    // Consumer still gets an emit (empty) — bootstrap failure doesn't block delivery.
    expect(states[states.length - 1]).toEqual([]);
    // But the failure is observable via the wpb debug ring buffer.
    const errs = wpb.debug.events().filter((e) => e.kind === "bootstrap-error");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].collection).toBe("items");
    expect((errs[0].detail as { phase?: string; status?: number }).phase).toBe("bootstrap");
    expect((errs[0].detail as { phase?: string; status?: number }).status).toBe(401);
  });

  it("does NOT surface a bootstrap-error for a 404 on a single-record watch (legitimate empty)", async () => {
    const { mirror, wpb } = setup();
    // Record doesn't exist; getOne throws 404. This is the "subscribe(id) on
    // a missing record stays armed for future creates" path — not an error.
    const states: RawRecord[][] = [];
    mirror.watch({ collection: "items", topic: "missing" }, (s) => { states.push(s); });
    await flush();

    expect(states[states.length - 1]).toEqual([]);
    const errs = wpb.debug.events().filter((e) => e.kind === "bootstrap-error");
    expect(errs.length).toBe(0);
  });
});

describe("PBMirror: SDK quirk defense / resync", () => {
  it("(30) resync(): re-runs initial fetch; emits drift", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);

    // Server mutates while our SSE is silent (we do NOT call stub.emit).
    stub.col("items").records.set("b", rec("items", { id: "b", list: "L1" }));
    stub.col("items").records.delete("a");

    await mirror.resync();
    await flush();

    expect(states[states.length - 1].map((r) => r.id).sort()).toEqual(["b"]);
  });
});

// =====================================================================
// Reconnect-driven resync (PB_CONNECT after a real SSE drop)
//
// Two complementary triggers feed resync():
//   - PB_CONNECT after onDisconnect (this block) — the precise desktop/wifi
//     path: the SDK noticed the drop, so we resync the instant SSE returns.
//   - focus/visibility (backend-provider) — the backstop for SILENT mobile
//     suspends where the OS freezes the network stack and the SDK never sees
//     a clean disconnect/PB_CONNECT.
// =====================================================================

describe("PBMirror: reconnect-driven resync", () => {
  it("resyncs on PB_CONNECT after a reported disconnect — no focus needed", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();
    expect(states[states.length - 1].map((r) => r.id)).toEqual(["a"]);
    const fetchesBefore = stub.col("items").fetchCalls;

    // Peer mutates while our SSE is presumed dead (no stub.emit).
    stub.col("items").records.set("b", rec("items", { id: "b", list: "L1" }));

    // SDK reports drop + reconnect; the mirror should resync itself.
    stub.dropAndReconnect(["items"]);
    await flush();

    expect(stub.col("items").fetchCalls, "exactly one refetch on reconnect").toBe(fetchesBefore + 1);
    expect(states[states.length - 1].map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("does NOT resync on the INITIAL PB_CONNECT (no prior disconnect)", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      () => {},
    );
    await flush();
    const fetchesBefore = stub.col("items").fetchCalls;

    // First connect after subscribe — bootstrap already fetched, so this must
    // NOT trigger a duplicate refetch.
    stub.fireConnect();
    await flush();

    expect(stub.col("items").fetchCalls, "no resync on initial connect").toBe(fetchesBefore);
  });

  it("focus-driven resync() still works as the mobile-suspend backstop", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    // Silent suspend: no onDisconnect/PB_CONNECT ever fires. Peer mutated.
    stub.col("items").records.set("b", rec("items", { id: "b", list: "L1" }));

    // backend-provider's focus handler calls mirror.resync() directly.
    await mirror.resync();
    await flush();

    expect(states[states.length - 1].map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("coalesces: a focus resync immediately after a reconnect resync does not double-refetch", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      () => {},
    );
    await flush();
    const fetchesBefore = stub.col("items").fetchCalls;

    // Reconnect resync fires...
    stub.dropAndReconnect(["items"]);
    await flush();
    const afterReconnect = stub.col("items").fetchCalls;
    expect(afterReconnect).toBe(fetchesBefore + 1);

    // ...and a focus event lands milliseconds later. The coalesce window
    // suppresses the redundant second full refetch.
    await mirror.resync();
    await flush();
    expect(stub.col("items").fetchCalls, "coalesced — no second refetch").toBe(afterReconnect);
  });

  it("force (reconnect) BYPASSES coalesce even right after a focus resync", async () => {
    // Mobile-wake ordering: focus fires first (backstop, stamps lastResyncAt),
    // then the network returns and SSE reconnects ~1-2s later — INSIDE the
    // coalesce window. A symmetric coalesce would wrongly drop the reconnect
    // resync (and since PB_CONNECT already cleared realtimeDirty, the drop is
    // silent → stale data). force:true must override the window so the
    // authoritative reconnect signal always fetches.
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    const states: RawRecord[][] = [];
    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      (s) => { states.push(s); },
    );
    await flush();

    // Focus resync lands first (backstop) — coalesced path, stamps the window.
    await mirror.resync();
    await flush();
    const afterFocus = stub.col("items").fetchCalls;

    // Peer mutated while SSE was down (no stub.emit reached us).
    stub.col("items").records.set("b", rec("items", { id: "b", list: "L1" }));

    // Reconnect lands immediately afterward, well inside the 2s window.
    stub.dropAndReconnect(["items"]);
    await flush();

    expect(stub.col("items").fetchCalls, "force resync ran despite the window").toBe(afterFocus + 1);
    expect(states[states.length - 1].map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("a disconnect with NO active subscriptions does not arm a resync", async () => {
    // The SDK's onDisconnect also fires on graceful unsubscribe-all teardown.
    // Only a drop with live subs should arm the dirty flag.
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      () => {},
    );
    await flush();
    const fetchesBefore = stub.col("items").fetchCalls;

    stub.dropAndReconnect([]); // empty active subs
    await flush();

    expect(stub.col("items").fetchCalls, "graceful close must not resync").toBe(fetchesBefore);
  });

  it("two mirrors on one pb: M1 dispose must not clobber M2's onDisconnect", async () => {
    // onDisconnect is a single settable slot. Chain: M2 → M1 → orig(undefined).
    // Disposing M1 first must NOT blind-restore the slot (that would knock M2's
    // live handler off). Restore only-if-on-top keeps M2 effective; after both
    // dispose the slot is back to the original with no dangling disposed-mirror
    // closure left firing.
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const realtime = (stub.pb as unknown as { realtime: { onDisconnect?: unknown } }).realtime;
    expect(realtime.onDisconnect, "slot starts empty").toBeUndefined();

    const mirror1 = createMirror(() => stub.pb, wpb);
    const mirror2 = createMirror(() => stub.pb, wpb);

    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));
    stub.col("other").records.set("x", rec("other", { id: "x", list: "L1" }));

    mirror1.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      () => {},
    );
    mirror2.watch(
      { collection: "other", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      () => {},
    );
    await flush();

    // Dispose M1 (creation order). M2's handler must survive on the slot.
    mirror1.dispose();
    await flush();
    expect(realtime.onDisconnect, "M2 still installed after M1 dispose").not.toBeUndefined();

    // A real drop+reconnect must still resync M2 (its realtimeDirty armed).
    const otherBefore = stub.col("other").fetchCalls;
    stub.dropAndReconnect(["other"]);
    await flush();
    expect(stub.col("other").fetchCalls, "M2 resynced after M1 dispose").toBe(otherBefore + 1);

    // Dispose M2 (out-of-creation-order means M2 restores to M1's now-disposed
    // handler — single-slot chaining can't splice M1 out without a ref to it).
    // That's fine: whatever closure remains must be INERT (the `disposed` guard
    // makes it a no-op). Assert no live mirror is reachable: a drop+reconnect
    // after both dispose refetches nothing.
    mirror2.dispose();
    await flush();
    const itemsBefore = stub.col("items").fetchCalls;
    const otherAfter = stub.col("other").fetchCalls;
    stub.dropAndReconnect(["items", "other"]);
    await flush();
    expect(stub.col("items").fetchCalls, "M1 inert after dispose").toBe(itemsBefore);
    expect(stub.col("other").fetchCalls, "M2 inert after dispose").toBe(otherAfter);
  });

  it("dispose() tears down the PB_CONNECT subscription (no leaked listener)", async () => {
    const { stub, mirror } = setup();
    stub.col("items").records.set("a", rec("items", { id: "a", list: "L1" }));

    mirror.watch(
      { collection: "items", topic: "*", filter: "list = 'L1'", predicate: (r) => r.list === "L1" },
      () => {},
    );
    await flush();
    expect(stub.pbConnectListenerCount()).toBe(1);

    mirror.dispose();
    await flush();
    expect(stub.pbConnectListenerCount(), "PB_CONNECT listener removed on dispose").toBe(0);

    // And a post-dispose reconnect is inert (no refetch).
    const fetchesBefore = stub.col("items").fetchCalls;
    stub.dropAndReconnect(["items"]);
    await flush();
    expect(stub.col("items").fetchCalls).toBe(fetchesBefore);
  });
});

// =====================================================================
// watchCombined
// =====================================================================

describe("PBMirror: watchCombined", () => {
  it("waits for ALL specs before first emit; re-emits on any change", async () => {
    const { stub, mirror } = setup();
    stub.col("A").records.set("a1", rec("A", { id: "a1", v: "1" }));
    stub.col("B").records.set("b1", rec("B", { id: "b1", w: "2" }));

    const emits: Array<readonly [RawRecord[], RawRecord[]]> = [];
    mirror.watchCombined(
      [
        { collection: "A", topic: "*", filter: "v = '1'", predicate: () => true },
        { collection: "B", topic: "*", filter: "w = '2'", predicate: () => true },
      ],
      ([a, b]) => { emits.push([a, b] as const); },
    );
    await flush();

    expect(emits).toHaveLength(1);
    expect(emits[0][0].map((r) => r.id)).toEqual(["a1"]);
    expect(emits[0][1].map((r) => r.id)).toEqual(["b1"]);

    // Change one source → combined emits.
    stub.emit("A", { action: "create", record: rec("A", { id: "a2", v: "1" }) });
    await flush();
    expect(emits.length).toBeGreaterThanOrEqual(2);
    expect(emits[emits.length - 1][0].map((r) => r.id).sort()).toEqual(["a1", "a2"]);
    expect(emits[emits.length - 1][1].map((r) => r.id)).toEqual(["b1"]);
  });

  it("synchronous unsubscribe before initial state: no emits", async () => {
    const { stub, mirror } = setup();
    stub.col("A").records.set("a1", rec("A", { id: "a1", v: "1" }));
    stub.hold();

    const emits: number[] = [];
    const handle = mirror.watchCombined(
      [
        { collection: "A", topic: "*", filter: "v = '1'", predicate: () => true },
        { collection: "B", topic: "*", filter: "w = '2'", predicate: () => true },
      ],
      () => { emits.push(1); },
    );
    handle.unsubscribe();
    stub.release();
    await flush();
    expect(emits).toHaveLength(0);
  });
});
