/**
 * PocketBaseUserBackend tests — unit-level, against a stub PocketBase.
 *
 * Covers the cancel-before-resolve race in subscribeSlugs (Bug B): a caller
 * that calls the returned unsubscribe before wpb.subscribe's promise resolves
 * must NOT leak the underlying local subscriber once the promise lands.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel, RecordSubscription, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase } from "../wrapped-pb";
import { clearAllMutations } from "../wrapped-pb/persistence";
import { PocketBaseUserBackend } from "./user";

type RealtimeCb = (e: { action: string; record: RecordModel }) => void;

interface StubCollection {
  records: Map<string, RecordModel>;
  realtimeCbs: Set<RealtimeCb>;
  /** Gates the next getOne; tests use this to keep wpb.subscribe's initial
   *  load pending while exercising cancel-before-resolve. */
  gateGetOne: Promise<void> | null;
}

interface WpbInternals {
  /** Per-collection local subscriber count (read via the collections Map). */
  countSubscribers: (collection: string) => number;
}

function makeStubPb(): {
  pb: PocketBase;
  emit: (col: string, e: { action: string; record: RecordModel }) => void;
  col: (n: string) => StubCollection;
} {
  const cols = new Map<string, StubCollection>();
  const get = (n: string): StubCollection => {
    let c = cols.get(n);
    if (!c) {
      c = { records: new Map(), realtimeCbs: new Set(), gateGetOne: null };
      cols.set(n, c);
    }
    return c;
  };

  const stub = {
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
          const id = (body.id as string) ?? "x";
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
          if (c.gateGetOne) {
            await c.gateGetOne;
            c.gateGetOne = null;
          }
          const r = c.records.get(id);
          if (!r) throw Object.assign(new Error("not found"), { status: 404 });
          return r;
        },
        async getFullList(): Promise<RecordModel[]> {
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

/**
 * Re-implements the visibility wpb deliberately doesn't expose: we want to
 * assert "no orphaned LocalSubscriber sticks around after a racy unsubscribe."
 * Each call to wpb.collection(name).subscribe(...) adds one to a per-collection
 * Set; the returned unsubscribe (or our Bug B fix path) must remove it.
 *
 * We reach in via the stub's realtime-callback count as a proxy: every wpb
 * .subscribe call ends up adding ONE realtime callback to the stub for that
 * collection (via ensureRealSubscription), and the count returns to 0 when
 * the last local subscriber departs. If the local subscriber leaks, the
 * realtime callback also leaks.
 */
function makeProbe(stub: ReturnType<typeof makeStubPb>): WpbInternals {
  return {
    countSubscribers: (collection: string) => stub.col(collection).realtimeCbs.size,
  };
}

beforeEach(async () => {
  await clearAllMutations();
});

describe("PocketBaseUserBackend.subscribeSlugs cancellation", () => {
  it("does not leak the underlying subscription when unsub is called before wpb.subscribe resolves", async () => {
    // Bug B repro: the cleanup function captured `unsub` by closure, but if
    // wpb.subscribe's promise (which awaits getOne for initial-load) hasn't
    // resolved by the time the caller unsubscribes, `unsub` is undefined and
    // the cleanup is a no-op. Then the promise resolves, the local
    // subscriber/realtime callback are registered, and nothing ever tears
    // them down.
    const stub = makeStubPb();
    const probe = makeProbe(stub);

    // Seed a user record so the resolved getOne would return something
    // realistic; the bug repros regardless of 200 vs 404.
    stub.col("users").records.set("u1", {
      id: "u1",
      collectionId: "users",
      collectionName: "users",
      created: "",
      updated: "",
      shopping_slugs: { groceries: "L1" },
    } as unknown as RecordModel);

    // Hold getOne open so wpb.subscribe's promise stays pending.
    let releaseGetOne: () => void = () => {};
    stub.col("users").gateGetOne = new Promise<void>((res) => { releaseGetOne = res; });

    const wpb = wrapPocketBase(() => stub.pb);
    const user = new PocketBaseUserBackend(() => stub.pb, wpb);

    const seen: Array<Record<string, string>> = [];
    const unsubscribe = user.subscribeSlugs("u1", "shopping", (s) => seen.push(s));

    // Immediately tear down — BEFORE the wpb.subscribe promise resolves.
    unsubscribe();

    // Now let getOne finish, which lets wpb.subscribe's promise resolve and
    // the inner .then run.
    releaseGetOne();
    // Drain microtasks so the .then chain inside subscribeSlugs lands.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // No subscriber should remain — the cancel-before-resolve handler must
    // tear down the late-resolved subscription as soon as it lands.
    expect(
      probe.countSubscribers("users"),
      "subscribeSlugs leaked a subscription when teardown raced wpb.subscribe.then",
    ).toBe(0);

    // And the callback must never have fired (we unsubscribed before any
    // initial event could be delivered).
    expect(seen).toEqual([]);
  });

  it("normal teardown after the promise resolves still works", async () => {
    // Regression guard: the fix path must not break the common case where
    // wpb.subscribe resolves before cancellation.
    const stub = makeStubPb();
    const probe = makeProbe(stub);
    stub.col("users").records.set("u1", {
      id: "u1",
      collectionId: "users",
      collectionName: "users",
      created: "",
      updated: "",
      shopping_slugs: {},
    } as unknown as RecordModel);

    const wpb = wrapPocketBase(() => stub.pb);
    const user = new PocketBaseUserBackend(() => stub.pb, wpb);

    const seen: Array<Record<string, string>> = [];
    const unsubscribe = user.subscribeSlugs("u1", "shopping", (s) => seen.push(s));

    // Let initial load + delivery happen.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(seen.length).toBeGreaterThan(0);
    expect(probe.countSubscribers("users")).toBe(1);

    unsubscribe();
    // Last local subscriber departs — wpb tears down the real SSE.
    await new Promise((r) => setTimeout(r, 0));
    expect(probe.countSubscribers("users")).toBe(0);
  });
});

describe("PocketBaseUserBackend.setSlug concurrency", () => {
  it("two parallel setSlug calls for the same user both survive (no last-write-wins drop)", async () => {
    // Bug A repro: setSlug does readUser → merge → wpb.update. Two
    // concurrent calls both read the same baseline (empty), each merge in
    // their own slug, each write back the single-slug map. Pre-fix, the
    // network ack ordering decides which slug survives — the other is
    // silently dropped.
    const stub = makeStubPb();
    stub.col("users").records.set("u1", {
      id: "u1",
      collectionId: "users",
      collectionName: "users",
      created: "",
      updated: "",
      shopping_slugs: {},
    } as unknown as RecordModel);

    const wpb = wrapPocketBase(() => stub.pb);
    const user = new PocketBaseUserBackend(() => stub.pb, wpb);

    await Promise.all([
      user.setSlug("u1", "shopping", "groceries", "L1"),
      user.setSlug("u1", "shopping", "hardware", "L2"),
    ]);

    const finalServer = stub.col("users").records.get("u1") as unknown as Record<string, unknown>;
    const slugs = finalServer.shopping_slugs as Record<string, string>;
    expect(slugs).toEqual({ groceries: "L1", hardware: "L2" });
  });

  it("two parallel saveFcmToken calls both tokens survive", async () => {
    // Same get-then-set race for the fcm_tokens array. A cross-device
    // install could otherwise lose a token, breaking push delivery to one
    // of the user's devices.
    const stub = makeStubPb();
    stub.col("users").records.set("u1", {
      id: "u1",
      collectionId: "users",
      collectionName: "users",
      created: "",
      updated: "",
      fcm_tokens: [],
    } as unknown as RecordModel);

    const wpb = wrapPocketBase(() => stub.pb);
    const user = new PocketBaseUserBackend(() => stub.pb, wpb);

    await Promise.all([
      user.saveFcmToken("u1", "device-A-token"),
      user.saveFcmToken("u1", "device-B-token"),
    ]);

    const finalServer = stub.col("users").records.get("u1") as unknown as Record<string, unknown>;
    const tokens = (finalServer.fcm_tokens as string[]).slice().sort();
    expect(tokens).toEqual(["device-A-token", "device-B-token"]);
  });

  it("serialized setSlug + removeSlug compose to the expected final state", async () => {
    // Mixed ops on the same field must also serialize cleanly.
    const stub = makeStubPb();
    stub.col("users").records.set("u1", {
      id: "u1",
      collectionId: "users",
      collectionName: "users",
      created: "",
      updated: "",
      shopping_slugs: { groceries: "L1" },
    } as unknown as RecordModel);

    const wpb = wrapPocketBase(() => stub.pb);
    const user = new PocketBaseUserBackend(() => stub.pb, wpb);

    await Promise.all([
      user.setSlug("u1", "shopping", "hardware", "L2"),
      user.removeSlug("u1", "shopping", "groceries"),
      user.setSlug("u1", "shopping", "pantry", "L3"),
    ]);

    const finalServer = stub.col("users").records.get("u1") as unknown as Record<string, unknown>;
    const slugs = finalServer.shopping_slugs as Record<string, string>;
    // Exact ordering depends on the serializer, but the invariant is "no
    // get-then-set loss": every op's intent must be reflected in the final
    // state, modulo the explicit removeSlug. So groceries must be gone and
    // hardware+pantry must both be present.
    expect(slugs.groceries).toBeUndefined();
    expect(slugs.hardware).toBe("L2");
    expect(slugs.pantry).toBe("L3");
  });
});

// Touch the unused RecordSubscription import to satisfy strict linters.
export type _Touch = RecordSubscription;
