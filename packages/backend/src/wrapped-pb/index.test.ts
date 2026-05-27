/**
 * Unit tests for wrapPocketBase using a stub PocketBase.
 *
 * wpb's job after the mirror migration is the write path: optimistic queue
 * + IDB persistence + transient-error retry. Live state delivery is the
 * mirror's responsibility (see mirror.test.ts + realworld.test.ts), so
 * these tests assert on `queue.view`, `debug.snapshot`, and `debug.events`
 * — the surfaces wpb actually exposes to its (single) consumer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import { wrapPocketBase, WrappedPbError, type MutationQueue } from "./index";
import { clearAllMutations } from "./persistence";

/** Tests sometimes need to seed the mutation queue with a server snapshot
 *  (what the mirror would do on bootstrap). */
function queueOf(wpb: ReturnType<typeof wrapPocketBase>): MutationQueue {
  return wpb.mirrorIntegration.queue;
}

interface StubCollection {
  records: Map<string, RecordModel>;
  /** Lets a test reject the next operation. */
  rejectNext: { create?: unknown; update?: unknown; delete?: unknown };
  /** Number of times `pb.collection(name).create(...)` was invoked. */
  createCalls: number;
}

interface StubRealtime {
  pbConnectCbs: Set<(e: unknown) => void>;
  /** Test-only: fire PB_CONNECT to simulate the SDK reconnecting. */
  firePbConnect: () => void;
}

function makeStubPb(): {
  pb: PocketBase;
  col: (n: string) => StubCollection;
  realtime: StubRealtime;
} {
  const cols = new Map<string, StubCollection>();
  const get = (n: string): StubCollection => {
    let c = cols.get(n);
    if (!c) {
      c = { records: new Map(), rejectNext: {}, createCalls: 0 };
      cols.set(n, c);
    }
    return c;
  };

  const realtime: StubRealtime = {
    pbConnectCbs: new Set(),
    firePbConnect() {
      for (const cb of this.pbConnectCbs) cb({});
    },
  };

  const stub = {
    realtime: {
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
          c.createCalls += 1;
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
      };
    },
  } as unknown as PocketBase;

  return { pb: stub, col: get, realtime };
}

beforeEach(async () => {
  await clearAllMutations();
});

describe("wrapPocketBase optimistic writes", () => {
  it("create surfaces the synthesized record immediately via view()", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const ack = wpb.collection("items").create({ id: "a", name: "x", list: "L1" });
    // Synchronously visible to the queue / mirror's materialize() — no await needed.
    const view = wpb.collection("items").view<RecordModel & { name?: string }>("a");
    expect(view).not.toBeNull();
    expect(view!.id).toBe("a");
    expect(view!.name).toBe("x");

    await ack;
    expect(stub.col("items").records.has("a")).toBe(true);
  });

  it("update composes onto the server snapshot in view()", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seed: RecordModel = { id: "a", name: "old", note: "n", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.col("items").records.set("a", seed);
    // Mirror would call applyServer on its initial fetch — emulate that.
    queueOf(wpb).applyServer("items", "a", seed as unknown as Parameters<ReturnType<typeof queueOf>["applyServer"]>[2]);

    const ack = wpb.collection("items").update("a", { name: "new" });
    const view = wpb.collection("items").view<RecordModel & { name: string; note: string }>("a");
    expect(view!.name).toBe("new");
    expect(view!.note).toBe("n");

    await ack;
  });

  it("delete tombstones the view immediately", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seed: RecordModel = { id: "a", list: "L1", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.col("items").records.set("a", seed);
    queueOf(wpb).applyServer("items", "a", seed as unknown as Parameters<ReturnType<typeof queueOf>["applyServer"]>[2]);

    const ack = wpb.collection("items").delete("a");
    expect(wpb.collection("items").view("a")).toBeNull();

    await ack;
  });
});

describe("wrapPocketBase rejection", () => {
  it("permanent error (403) drops the pending mutation and throws WrappedPbError", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    stub.col("items").rejectNext.create = Object.assign(new Error("forbidden"), { status: 403 });

    let caught: unknown = null;
    try {
      await wpb.collection("items").create({ id: "a", list: "L1" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WrappedPbError);
    const wrapped = caught as WrappedPbError;
    expect(wrapped.op).toEqual({ kind: "create", collection: "items", recordId: "a" });
    expect((wrapped.originalError as { status?: number }).status).toBe(403);
    // Mutation drained from the queue — view() returns null again.
    expect(wpb.collection("items").view("a")).toBeNull();
    expect(wpb.debug.snapshot().totalPending).toBe(0);
  });

  it("rejected update rolls the view back to the prior server snapshot", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    const seed = { id: "a", name: "server", collectionId: "items", collectionName: "items", created: "", updated: "" } as unknown as RecordModel;
    stub.col("items").records.set("a", seed);
    queueOf(wpb).applyServer("items", "a", seed as unknown as Parameters<ReturnType<typeof queueOf>["applyServer"]>[2]);

    stub.col("items").rejectNext.update = Object.assign(new Error("forbidden"), { status: 403 });

    let rejected = false;
    try {
      await wpb.collection("items").update("a", { name: "optimistic" });
    } catch {
      rejected = true;
    }

    expect(rejected).toBe(true);
    const view = wpb.collection("items").view<RecordModel & { name: string }>("a");
    expect(view!.name).toBe("server");
  });
});

describe("wrapPocketBase transient-error queue + retry", () => {
  it("503 keeps the mutation pending, does NOT throw, and records an errored event", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    stub.col("items").rejectNext.create = Object.assign(new Error("service unavailable"), { status: 503 });

    let caught: unknown = null;
    try {
      await wpb.collection("items").create({ id: "a", list: "L1" });
    } catch (err) {
      caught = err;
    }

    // Caller's await resolves successfully — transient errors don't throw.
    expect(caught, "transient error must not throw to the caller").toBeNull();

    // Mutation is still in the queue (optimistic UI source of truth).
    expect(wpb.collection("items").view("a")).not.toBeNull();

    // Snapshot reflects the errored state.
    const snap = wpb.debug.snapshot();
    expect(snap.totalErrored).toBe(1);
    expect(snap.collections.items.erroredMutations).toBe(1);
    expect(snap.totalPending).toBe(1);

    // mutation-error event recorded with transient: true.
    const errEvent = wpb.debug.events().find((e) => e.kind === "mutation-error");
    expect(errEvent).toBeDefined();
    expect((errEvent!.detail as { transient?: boolean }).transient).toBe(true);
  });

  it("network failure (no status) is classified transient", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    // No status — simulates fetch throwing (offline, CORS, etc.)
    stub.col("items").rejectNext.create = new Error("Failed to fetch");

    let caught: unknown = null;
    try {
      await wpb.collection("items").create({ id: "a", list: "L1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeNull();
    expect(wpb.debug.snapshot().totalErrored).toBe(1);
  });

  it("permanent error (403) drains the mutation and throws — unchanged from prior behavior", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    stub.col("items").rejectNext.create = Object.assign(new Error("forbidden"), { status: 403 });

    let caught: unknown = null;
    try {
      await wpb.collection("items").create({ id: "a", list: "L1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WrappedPbError);
    expect(wpb.collection("items").view("a")).toBeNull();
    expect(wpb.debug.snapshot().totalErrored).toBe(0);
  });

  it("retryErrored re-fires queued writes; success drains them", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    // First attempt fails transiently.
    stub.col("items").rejectNext.create = Object.assign(new Error("temporarily down"), { status: 503 });
    await wpb.collection("items").create({ id: "a", list: "L1", name: "walnuts" });
    expect(wpb.debug.snapshot().totalErrored).toBe(1);

    // Network recovers — next create succeeds. (rejectNext is one-shot; not setting it means the call succeeds.)
    await wpb.retryErrored();
    // dispatchMutation in retryErrored is fire-and-forget (void); give microtasks a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(wpb.debug.snapshot().totalErrored).toBe(0);
    expect(wpb.debug.snapshot().totalPending).toBe(0);
    expect(stub.col("items").records.has("a")).toBe(true);
  });

  it("retryErrored leaves the mutation queued if the retry also fails transiently (attempts bumps)", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    stub.col("items").rejectNext.create = Object.assign(new Error("down 1"), { status: 503 });
    await wpb.collection("items").create({ id: "a", list: "L1" });

    stub.col("items").rejectNext.create = Object.assign(new Error("down 2"), { status: 503 });
    await wpb.retryErrored();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(wpb.debug.snapshot().totalErrored).toBe(1);
    const errorEvents = wpb.debug.events().filter((e) => e.kind === "mutation-error");
    expect(errorEvents.length).toBe(2);
    expect((errorEvents[1].detail as { attempts?: number }).attempts).toBe(2);
  });

  it("retryErrored is a no-op when there are no errored writes", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const eventsBefore = wpb.debug.events().length;
    await wpb.retryErrored();
    const eventsAfter = wpb.debug.events().length;
    expect(eventsAfter, "no retry-batch event should be recorded").toBe(eventsBefore);
  });

  it("PB_CONNECT auto-fires retryErrored after the first write hooks the lifecycle", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);

    // First write hooks PB_CONNECT lazily.
    stub.col("items").rejectNext.create = Object.assign(new Error("transient"), { status: 503 });
    await wpb.collection("items").create({ id: "a", list: "L1" });
    expect(wpb.debug.snapshot().totalErrored).toBe(1);

    // Fire PB_CONNECT — wpb should sweep the errored queue without manual retryErrored.
    stub.realtime.firePbConnect();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(wpb.debug.snapshot().totalErrored).toBe(0);
    expect(stub.col("items").records.has("a")).toBe(true);
  });
});
