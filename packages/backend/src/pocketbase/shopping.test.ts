/**
 * PocketBaseShoppingBackend tests — unit-level, against a stub PocketBase.
 *
 * Covers the cancel-before-resolve race in subscribeToList: a caller that
 * tears down the subscription before the inner wpb.subscribe / pb.subscribe
 * promises resolve must NOT leak the underlying realtime subscriptions once
 * those promises land. Same shape as the bug fixed in subscribeSlugs (see
 * user.test.ts) and the recipes / life / upkeep cleanup races.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase } from "../wrapped-pb";
import { clearAllMutations } from "../wrapped-pb/persistence";
import { PocketBaseShoppingBackend } from "./shopping";

type RealtimeCb = (e: { action: string; record: RecordModel }) => void;

interface StubCollection {
  records: Map<string, RecordModel>;
  realtimeCbs: Set<RealtimeCb>;
  /** Total subscribe(...) invocations on this collection, regardless of
   *  whether the resulting cb is later unsubscribed. Lets tests assert the
   *  inner pb.subscribe was never called at all (vs. called-then-unsubscribed,
   *  which is what the outer trackUnsub fix would leave behind). */
  subscribeCalls: number;
  /** Gates pending reads; tests use this to keep wpb.subscribe / getList
   *  promises pending while exercising cancel-before-resolve. */
  gateReads: Promise<void> | null;
}

function makeStubPb(): {
  pb: PocketBase;
  emit: (col: string, e: { action: string; record: RecordModel }) => void;
  col: (n: string) => StubCollection;
  release: () => void;
  hold: () => void;
} {
  const cols = new Map<string, StubCollection>();
  let releaseAll: () => void = () => {};
  let held = false;
  const get = (n: string): StubCollection => {
    let c = cols.get(n);
    if (!c) {
      c = { records: new Map(), realtimeCbs: new Set(), subscribeCalls: 0, gateReads: null };
      cols.set(n, c);
    }
    return c;
  };

  const stub = {
    filter: (expr: string, params: Record<string, string>) => {
      // Minimal stub — tests don't assert on filter contents.
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
          c.subscribeCalls += 1;
          c.realtimeCbs.add(cb);
          return async () => { c.realtimeCbs.delete(cb); };
        },
        async getOne(id: string): Promise<RecordModel> {
          if (c.gateReads) await c.gateReads;
          const r = c.records.get(id);
          if (!r) throw Object.assign(new Error("not found"), { status: 404 });
          return r;
        },
        async getFullList(): Promise<RecordModel[]> {
          if (c.gateReads) await c.gateReads;
          return Array.from(c.records.values());
        },
        async getList(_page: number, _per: number, _opts?: unknown): Promise<{ items: RecordModel[] }> {
          if (c.gateReads) await c.gateReads;
          return { items: Array.from(c.records.values()) };
        },
        async getFirstListItem(_filter: string): Promise<RecordModel> {
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
  };
}

/**
 * Counts wpb's underlying realtime subscribers across the four shopping
 * collections. Each subscribeToList call should add one realtime callback
 * per collection. After teardown the count must return to 0 — anything left
 * is a leaked subscription.
 */
function totalSubscribers(stub: ReturnType<typeof makeStubPb>): number {
  return (
    stub.col("shopping_lists").realtimeCbs.size +
    stub.col("shopping_items").realtimeCbs.size +
    stub.col("shopping_history").realtimeCbs.size +
    stub.col("shopping_trips").realtimeCbs.size
  );
}

beforeEach(async () => {
  await clearAllMutations();
});

describe("PocketBaseShoppingBackend.subscribeToList cancellation", () => {
  it("does not leak realtime subscriptions when unsub runs before the inner promises resolve", async () => {
    // Race repro: subscribeToList kicks off four inner subscribe(...).then(u
    // => unsubs.push(u)) chains. If the caller's cleanup runs before any of
    // those .then callbacks fire, the unsubs array is empty when the
    // closure iterates it, and the late-arriving `u` functions never get
    // called. The underlying pb realtime subscribers stay registered
    // forever — silent leak.
    const stub = makeStubPb();

    // Seed a list record so the resolved getOne would return something
    // realistic; the leak repros regardless of 200 vs 404.
    stub.col("shopping_lists").records.set("L1", {
      id: "L1",
      collectionId: "shopping_lists",
      collectionName: "shopping_lists",
      created: "",
      updated: "",
      name: "Groceries",
      owners: ["u1"],
      category_defs: [],
    } as unknown as RecordModel);

    // Hold all reads so wpb.subscribe / pb.getList stay pending.
    stub.hold();

    const wpb = wrapPocketBase(() => stub.pb);
    const shopping = new PocketBaseShoppingBackend(() => stub.pb, wpb);

    const unsubscribe = shopping.subscribeToList("L1", {
      onList: () => {},
      onItems: () => {},
      onHistory: () => {},
      onTrips: () => {},
    });

    // Tear down BEFORE any inner promise resolves.
    unsubscribe();

    // Let the gated reads complete. The four inner .then callbacks now run.
    stub.release();
    // Drain microtasks so every awaited chain inside subscribeToList lands.
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

    expect(
      totalSubscribers(stub),
      "subscribeToList leaked realtime subscribers when teardown raced the inner subscribe promises",
    ).toBe(0);
  });

  it("subscribeToCollectionReload does not invoke pb.subscribe when cancelled between reload() and subscribe()", async () => {
    // Internal-race repro: subscribeToCollectionReload awaits reload() *then*
    // awaits pb.subscribe(). The outer trackUnsub fix catches the leaked
    // unsub if cancellation lands between those two awaits — but the
    // subscribe call itself still fires, briefly registering a realtime cb
    // that's immediately torn down. The tighter fix threads an isCancelled
    // check between the two awaits so the subscribe never happens at all.
    //
    // Net subscriber count returns to 0 either way (the outer trackUnsub
    // tidies up). What differs is `subscribeCalls`: pre-fix it's 1 per
    // reload-based collection; post-fix it's 0.
    const stub = makeStubPb();
    stub.col("shopping_lists").records.set("L1", {
      id: "L1",
      collectionId: "shopping_lists",
      collectionName: "shopping_lists",
      created: "",
      updated: "",
      name: "Groceries",
      owners: ["u1"],
      category_defs: [],
    } as unknown as RecordModel);

    // Hold reads so the inner `await reload()` (which calls getList) stays
    // pending. Cancellation then lands before the subsequent pb.subscribe.
    stub.hold();

    const wpb = wrapPocketBase(() => stub.pb);
    const shopping = new PocketBaseShoppingBackend(() => stub.pb, wpb);

    const unsubscribe = shopping.subscribeToList("L1", {
      onList: () => {},
      onItems: () => {},
      onHistory: () => {},
      onTrips: () => {},
    });

    // Tear down before getList resolves — sets cancelled=true.
    unsubscribe();

    // Release: getList resolves, reload() finishes, then the function
    // proceeds to (or short-circuits before) pb.subscribe(...).
    stub.release();
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

    // The reload-based collections must not have hit pb.subscribe at all.
    expect(
      stub.col("shopping_history").subscribeCalls,
      "subscribeToCollectionReload called pb.subscribe on shopping_history after cancellation",
    ).toBe(0);
    expect(
      stub.col("shopping_trips").subscribeCalls,
      "subscribeToCollectionReload called pb.subscribe on shopping_trips after cancellation",
    ).toBe(0);

    // And the outer invariant from the first test still holds.
    expect(totalSubscribers(stub)).toBe(0);
  });

  it("normal teardown after the promises resolve still releases everything", async () => {
    // Regression guard: the cancel-before-resolve fix must not break the
    // common case where every inner subscribe lands before unsubscribe is
    // called.
    const stub = makeStubPb();
    stub.col("shopping_lists").records.set("L1", {
      id: "L1",
      collectionId: "shopping_lists",
      collectionName: "shopping_lists",
      created: "",
      updated: "",
      name: "Groceries",
      owners: ["u1"],
      category_defs: [],
    } as unknown as RecordModel);

    const wpb = wrapPocketBase(() => stub.pb);
    const shopping = new PocketBaseShoppingBackend(() => stub.pb, wpb);

    const unsubscribe = shopping.subscribeToList("L1", {
      onList: () => {},
      onItems: () => {},
      onHistory: () => {},
      onTrips: () => {},
    });

    // Let all four inner subscribe promises resolve.
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

    // Four collections, one subscriber each.
    expect(totalSubscribers(stub)).toBe(4);

    unsubscribe();
    // Microtask drain for any deferred teardown work inside wpb.
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

    expect(totalSubscribers(stub)).toBe(0);
  });
});
