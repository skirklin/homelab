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

interface StubRealtime {
  onDisconnect?: (activeSubs: string[]) => void;
  pbConnectCbs: Set<(e: unknown) => void>;
  /** Test-only: simulate the SDK detecting a disconnect-then-reconnect. */
  simulateDropAndReconnect: (activeSubs: string[]) => void;
}

function makeStubPb(): {
  pb: PocketBase;
  emit: (col: string, e: { action: string; record: RecordModel }) => void;
  col: (n: string) => StubCollection;
  realtime: StubRealtime;
} {
  const cols = new Map<string, StubCollection>();
  const get = (n: string): StubCollection => {
    let c = cols.get(n);
    if (!c) {
      c = { records: new Map(), realtimeCbs: new Set(), rejectNext: {} };
      cols.set(n, c);
    }
    return c;
  };

  const realtime: StubRealtime = {
    pbConnectCbs: new Set(),
    simulateDropAndReconnect(activeSubs: string[]) {
      this.onDisconnect?.(activeSubs);
      for (const cb of this.pbConnectCbs) cb({});
    },
  };

  const stub = {
    realtime: {
      get onDisconnect() { return realtime.onDisconnect; },
      set onDisconnect(fn) { realtime.onDisconnect = fn; },
      async subscribe(topic: string, cb: (e: unknown) => void) {
        if (topic === "PB_CONNECT") {
          realtime.pbConnectCbs.add(cb);
          return async () => { realtime.pbConnectCbs.delete(cb); };
        }
        return async () => {};
      },
    },
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
    realtime,
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

  it("two concurrent subscribers to the same record id both receive the initial create event", async () => {
    // Repro of the prod bug: home shell mounts ShoppingProvider and
    // RecipesProvider concurrently; both call wpb.collection('users')
    // .subscribe(uid). Whoever seeds the queue first should NOT prevent
    // the other subscriber from receiving its initial create event.
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seed: RecordModel = { id: "u1", shopping_slugs: { groceries: "L1" }, collectionId: "users", collectionName: "users", created: "", updated: "" } as unknown as RecordModel;
    stub.col("users").records.set("u1", seed);

    let seenA: RecordModel | null = null;
    let seenB: RecordModel | null = null;
    await Promise.all([
      wpb.collection("users").subscribe("u1", (e) => { seenA = e.record; }),
      wpb.collection("users").subscribe("u1", (e) => { seenB = e.record; }),
    ]);

    expect(seenA).not.toBeNull();
    expect(seenB).not.toBeNull();
  });

  it("two concurrent filtered '*' subscribers both receive initial creates for matching records", async () => {
    // Same race for collection-scope subscribes: e.g. two screens both
    // subscribing to the same shopping list's items. Both must see the
    // existing items, not just the first one to subscribe.
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const a: RecordModel = { id: "a", list: "L1", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    const b: RecordModel = { id: "b", list: "L1", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.col("items").records.set("a", a);
    stub.col("items").records.set("b", b);

    const seenA: RecordModel[] = [];
    const seenB: RecordModel[] = [];
    await Promise.all([
      wpb.collection("items").subscribe("*", (e) => { seenA.push(e.record); }, {
        filter: "list = 'L1'",
        local: (r) => r.list === "L1",
      }),
      wpb.collection("items").subscribe("*", (e) => { seenB.push(e.record); }, {
        filter: "list = 'L1'",
        local: (r) => r.list === "L1",
      }),
    ]);

    expect(seenA.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(seenB.map((r) => r.id).sort()).toEqual(["a", "b"]);
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

describe("wrapPocketBase resync", () => {
  it("delivers events the SSE channel missed: another user added a record while we were idle", async () => {
    // The user-reported repro: PocketBase disconnects realtime subscriptions
    // after 5 min of idle; if a peer adds a record during that window, SSE
    // never delivers the event. resync() must refetch the filter and emit
    // a "create" so subscribers' local state catches up without a refresh.
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const events: Array<{ action: string; id: string }> = [];
    await wpb.collection("items").subscribe(
      "*",
      (e) => events.push({ action: e.action, id: e.record.id }),
      { filter: "list = 'L1'", local: (r) => r.list === "L1" },
    );
    events.length = 0;

    // Simulate a peer's write that the SSE channel missed (no stub.emit).
    const peerRecord: RecordModel = {
      id: "walnuts", list: "L1", ingredient: "walnuts",
      collectionId: "items", collectionName: "items", created: "", updated: "",
    } as unknown as RecordModel;
    stub.col("items").records.set("walnuts", peerRecord);

    await wpb.resync();

    const walnut = events.find((e) => e.id === "walnuts");
    expect(walnut, "resync should synthesize a create for the missed record").toBeDefined();
    expect(walnut!.action).toBe("create");
  });

  it("emits a synthetic delete when a record we previously held disappears server-side during the disconnect", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seed: RecordModel = {
      id: "a", list: "L1", collectionId: "items", collectionName: "items", created: "", updated: "",
    } as unknown as RecordModel;
    stub.col("items").records.set("a", seed);

    const events: Array<{ action: string; id: string }> = [];
    await wpb.collection("items").subscribe(
      "*",
      (e) => events.push({ action: e.action, id: e.record.id }),
      { filter: "list = 'L1'", local: (r) => r.list === "L1" },
    );
    events.length = 0;

    // Peer deleted the record while our SSE was dead.
    stub.col("items").records.delete("a");
    await wpb.resync();

    const del = events.find((e) => e.id === "a");
    expect(del, "resync should synthesize a delete for the missing record").toBeDefined();
    expect(del!.action).toBe("delete");
  });

  it("auto-resyncs on PB_CONNECT after the SDK reports a disconnect — no focus event needed", async () => {
    // Desktop fast path: SDK reports the drop, autoreconnects, fires
    // PB_CONNECT, and we resync immediately. This is what makes the
    // failure window seconds instead of "next time the user happens to
    // refocus the tab."
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const events: Array<{ action: string; id: string }> = [];
    await wpb.collection("items").subscribe(
      "*",
      (e) => events.push({ action: e.action, id: e.record.id }),
      { filter: "list = 'L1'", local: (r) => r.list === "L1" },
    );
    events.length = 0;

    // Peer creates a record server-side while SSE is presumed dead.
    const peer: RecordModel = {
      id: "peer", list: "L1", collectionId: "items", collectionName: "items", created: "", updated: "",
    } as unknown as RecordModel;
    stub.col("items").records.set("peer", peer);

    // SDK reports drop+reconnect. wpb should resync without us calling it.
    stub.realtime.simulateDropAndReconnect(["items"]);
    // Resync is fire-and-forget inside the hook — give it a tick to land.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(events.find((e) => e.id === "peer"), "PB_CONNECT after onDisconnect should trigger resync").toBeDefined();
  });

  it("does not resync on PB_CONNECT when there was no prior disconnect (initial connect)", async () => {
    // PB_CONNECT also fires on the very first connect. Resyncing then would
    // duplicate the per-subscribe initial load.
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seed: RecordModel = {
      id: "a", list: "L1", collectionId: "items", collectionName: "items", created: "", updated: "",
    } as unknown as RecordModel;
    stub.col("items").records.set("a", seed);

    const events: Array<{ action: string; id: string }> = [];
    await wpb.collection("items").subscribe(
      "*",
      (e) => events.push({ action: e.action, id: e.record.id }),
      { filter: "list = 'L1'", local: (r) => r.list === "L1" },
    );
    events.length = 0;

    // Simulate a bare PB_CONNECT (no prior onDisconnect — e.g., the initial
    // connect that just completed). resync must NOT fire.
    for (const cb of stub.realtime.pbConnectCbs) cb({});
    await new Promise((r) => setTimeout(r, 0));

    expect(events, "bare PB_CONNECT should not trigger resync").toHaveLength(0);
  });

  it("skips collections whose SSE channel just delivered an event", async () => {
    // The cost-control invariant: a chatty foregrounded tab whose SSE is
    // demonstrably alive should pay nothing on focus. We mark the channel
    // fresh by emitting an SSE event, then assert resync didn't refetch.
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const events: Array<{ action: string; id: string }> = [];
    await wpb.collection("items").subscribe(
      "*",
      (e) => events.push({ action: e.action, id: e.record.id }),
      { filter: "list = 'L1'", local: (r) => r.list === "L1" },
    );
    events.length = 0;

    // SSE delivers a live event — channel is proven alive.
    const live: RecordModel = {
      id: "live", list: "L1", collectionId: "items", collectionName: "items", created: "", updated: "",
    } as unknown as RecordModel;
    stub.emit("items", { action: "create", record: live });
    events.length = 0;

    // Peer creates a record server-side. If resync ran, it would synthesize
    // a create. Because the channel is fresh, it must not.
    const peer: RecordModel = {
      id: "peer", list: "L1", collectionId: "items", collectionName: "items", created: "", updated: "",
    } as unknown as RecordModel;
    stub.col("items").records.set("peer", peer);

    await wpb.resync();
    expect(events.find((e) => e.id === "peer"), "resync should skip a recently-live channel").toBeUndefined();
  });

  it("emits nothing when the server state matches the local view", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seed: RecordModel = {
      id: "a", list: "L1", collectionId: "items", collectionName: "items", created: "", updated: "",
    } as unknown as RecordModel;
    stub.col("items").records.set("a", seed);

    const events: Array<{ action: string; id: string }> = [];
    await wpb.collection("items").subscribe(
      "*",
      (e) => events.push({ action: e.action, id: e.record.id }),
      { filter: "list = 'L1'", local: (r) => r.list === "L1" },
    );
    events.length = 0;

    await wpb.resync();

    expect(events, "resync on unchanged state should be a no-op").toHaveLength(0);
  });
});
