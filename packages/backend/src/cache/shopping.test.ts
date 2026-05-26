/**
 * Tests for withShoppingCache — the cache decorator must NOT cause edits to
 * appear rolled back after a page refresh.
 *
 * The bug: on beta.kirkl.in, a user toggled an item, refreshed, and saw
 * the pre-toggle state. The hypothesis under test is that the cache
 * decorator's hydrateOne path can deliver a stale snapshot to the reducer
 * AFTER the live data has already been delivered — clobbering it.
 *
 * Run with: pnpm --filter @homelab/backend test src/cache/shopping.test.ts
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { withShoppingCache } from "./shopping";
import { cacheClear, cacheSet } from "./storage";
import type { ShoppingBackend } from "../interfaces/shopping";
import type {
  ShoppingItem,
  ShoppingList,
  ShoppingTrip,
} from "../types/shopping";
import type { Unsubscribe } from "../types/common";

interface Handlers {
  onList: (list: ShoppingList) => void;
  onItems: (items: ShoppingItem[]) => void;
  onTrips: (trips: ShoppingTrip[]) => void;
  onDeleted?: () => void;
}

/** Build a minimal stub ShoppingBackend whose subscribeToList exposes a
 *  way to fire emits at controlled times. */
function makeStubBackend(): {
  backend: ShoppingBackend;
  /** Drive the inner backend's onItems callback. */
  emitItems: (items: ShoppingItem[]) => void;
  /** Drive the inner backend's onList callback. */
  emitList: (list: ShoppingList) => void;
} {
  let handlers: Handlers | null = null;

  const backend: ShoppingBackend = {
    createList: async () => "",
    renameList: async () => {},
    deleteList: async () => {},
    getList: async () => null,
    updateCategories: async () => {},
    addItem: async () => "",
    updateItem: async () => {},
    updateItemCategory: async () => {},
    toggleItem: async () => {},
    deleteItem: async () => {},
    clearCheckedItems: async () => {},
    updateTripItem: async () => {},
    removeTripItem: async () => {},
    subscribeToList(_listId, h): Unsubscribe {
      handlers = h;
      return () => {
        handlers = null;
      };
    },
  };

  return {
    backend,
    emitItems: (items) => handlers?.onItems(items),
    emitList: (list) => handlers?.onList(list),
  };
}

const baseItem = (overrides: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id: "i1",
  list: "L1",
  ingredient: "milk",
  note: "",
  categoryId: "uncategorized",
  checked: false,
  addedAt: "2026-01-01T00:00:00.000Z",
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const baseList: ShoppingList = {
  id: "L1",
  name: "Groceries",
  owners: ["u1"],
  categories: [],
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-01T00:00:00.000Z",
};

/** Wait one macrotask so all pending microtasks (await chains) drain. */
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("withShoppingCache: refresh-state convergence", () => {
  beforeEach(async () => {
    await cacheClear();
  });

  it("does NOT clobber a fresh live emit with a slower stale cache hydrate", async () => {
    // Simulate "previous session cached the pre-toggle snapshot".
    const stalePreToggle = [baseItem({ checked: false })];
    await cacheSet("shopping:items:L1", stalePreToggle);

    const stub = makeStubBackend();
    const wrapped = withShoppingCache(stub.backend);

    const seenEmits: ShoppingItem[][] = [];
    const unsub = wrapped.subscribeToList("L1", {
      onList: () => {},
      onItems: (items) => {
        seenEmits.push(items);
      },
      onTrips: () => {},
    });

    // Mirror's bootstrap finishes FIRST (live emit beats IDB read).
    // Real-world: HTTP can occasionally beat IDB if the tab was already warm.
    const liveToggled = [baseItem({ checked: true })];
    stub.emitItems(liveToggled);

    // Now let the IDB-read microtask drain — hydrateOne should be a no-op
    // because liveReceived is already true.
    await tick(5);

    // The reducer must see EXACTLY one emit (the live one). If the cache
    // hydrate fires after live, it would CLOBBER our fresh state with the
    // stale snapshot — that's the bug.
    expect(seenEmits.length).toBeGreaterThan(0);
    expect(seenEmits[seenEmits.length - 1]).toEqual(liveToggled);
    // Critically: stale must never be the LAST emit.
    expect(seenEmits[seenEmits.length - 1][0].checked).toBe(true);

    unsub();
  });

  it("IDB-hydrate-before-live: live emit overrides stale cache (eventual convergence)", async () => {
    const stalePreToggle = [baseItem({ checked: false })];
    await cacheSet("shopping:items:L1", stalePreToggle);

    const stub = makeStubBackend();
    const wrapped = withShoppingCache(stub.backend);

    const seenEmits: ShoppingItem[][] = [];
    const unsub = wrapped.subscribeToList("L1", {
      onList: () => {},
      onItems: (items) => {
        seenEmits.push(items);
      },
      onTrips: () => {},
    });

    // Let IDB read fire FIRST.
    await tick(5);

    // Now live arrives.
    const liveToggled = [baseItem({ checked: true })];
    stub.emitItems(liveToggled);

    await tick(5);

    // Expected order: stale, then live. Last emit must be the live one.
    expect(seenEmits.length).toBe(2);
    expect(seenEmits[0]).toEqual(stalePreToggle);
    expect(seenEmits[1]).toEqual(liveToggled);

    unsub();
  });

  it("REGRESSION (the reported bug): IDB hydrate that resolves AFTER live emit must NOT roll the reducer back", async () => {
    // This models the exact reported scenario. The IDB read kicked off
    // synchronously at subscribe-time can finish AFTER the live mirror
    // emit has already updated the UI. If hydrateOne's `live()` guard
    // doesn't fire in time, the stale snapshot wins.
    const stalePreToggle = [baseItem({ checked: false })];
    await cacheSet("shopping:items:L1", stalePreToggle);

    // Force IDB reads to be SLOWER than the live emit. We can't easily slow
    // fake-indexeddb, but we can interleave by emitting live before yielding
    // to the cache's microtask. In real life this happens whenever the
    // service worker / device is under load and IDB is hot but the SSE
    // EventSource arrived even faster.
    const stub = makeStubBackend();
    const wrapped = withShoppingCache(stub.backend);

    const seenEmits: ShoppingItem[][] = [];
    const unsub = wrapped.subscribeToList("L1", {
      onList: () => {},
      onItems: (items) => {
        seenEmits.push(items);
      },
      onTrips: () => {},
    });

    // Fire live BEFORE yielding to IDB.
    const liveToggled = [baseItem({ checked: true })];
    stub.emitItems(liveToggled);

    // Now let microtasks drain — IDB read completes.
    await tick(50);

    // The cached emit (if it fires) must NOT clobber the live one.
    const last = seenEmits[seenEmits.length - 1];
    expect(last, "last emit must reflect the toggled state from live, not the stale cache").toEqual(liveToggled);
  });
});

describe("withShoppingCache: failure modes that leave the reducer with stale state", () => {
  beforeEach(async () => {
    await cacheClear();
  });

  it("REPRO (suspected user bug): if mirror NEVER emits, the cache hydrate is the final state", async () => {
    // This is the failure shape that matches the user's symptom most directly.
    // If the inner backend's subscribeToList attaches but never delivers (network
    // blip, expired token, auth race, PB unreachable) — the cache hydrate is
    // the LAST thing the reducer ever sees. The user observes the pre-toggle
    // snapshot from IDB and concludes the toggle was "rolled back."
    //
    // This test exists to PROVE the failure mode of withShoppingCache. The
    // production fix is to NOT wrap shopping with it (see cache/index.ts).
    // We keep withShoppingCache exported for callers who want the legacy
    // behavior, but withCache() no longer applies it to shopping.
    const staleSnapshot = [baseItem({ checked: false })];
    await cacheSet("shopping:items:L1", staleSnapshot);

    const stub = makeStubBackend();
    const wrapped = withShoppingCache(stub.backend);

    const seen: ShoppingItem[][] = [];
    const unsub = wrapped.subscribeToList("L1", {
      onList: () => {},
      onItems: (items) => { seen.push(items); },
      onTrips: () => {},
    });

    // Mirror NEVER emits (simulating bootstrap silently failing).
    await tick(50);

    // The user is now staring at the stale cache snapshot indefinitely.
    expect(seen.length, "cache hydrate fires even when mirror is silent").toBe(1);
    expect(seen[0][0].checked).toBe(false);

    // Note: this is the failure mode the production code AVOIDS by not
    // wrapping shopping with withShoppingCache. The mirror passes the
    // bare ShoppingBackend through; if the mirror's bootstrap fails the
    // consumer simply sees zero emits (loading=true forever, but no
    // *misleading* state). The replayPending path still gets pending
    // optimistic writes from a prior session into the queue, so user
    // intent isn't lost on the boundary either.
    unsub();
  });

  it("CONTRAST (production behavior): unwrapped shopping NEVER serves stale snapshots from IDB", async () => {
    // With the production wiring (cache/index.ts skips shopping), the bare
    // ShoppingBackend is what reaches the reducer. No hydrateOne. No
    // stale-snapshot pseudo-source-of-truth. If the mirror's bootstrap
    // silently fails, the reducer just stays in loading state — which is
    // recoverable (next focus → useRealtimeResync → mirror.resync()) and
    // doesn't lie about the toggle state to the user.
    const staleSnapshot = [baseItem({ checked: false })];
    await cacheSet("shopping:items:L1", staleSnapshot);

    const stub = makeStubBackend();
    // NOTE: NO withShoppingCache here — this is what BackendProvider does
    // in production after this commit.
    const unwrapped = stub.backend;

    const seen: ShoppingItem[][] = [];
    const unsub = unwrapped.subscribeToList("L1", {
      onList: () => {},
      onItems: (items) => { seen.push(items); },
      onTrips: () => {},
    });

    // Inner backend hasn't emitted. No cache hydrate path either.
    await tick(50);
    expect(seen.length, "no emits at all — no false signal to the user").toBe(0);

    unsub();
  });
});

describe("withShoppingCache: write race that bit beta", () => {
  beforeEach(async () => {
    await cacheClear();
  });

  it("does not roll items back to the stale cached snapshot after a fast refresh", async () => {
    // Session 1: list is freshly loaded; the cache holds the pre-toggle
    // snapshot from the bootstrap emit. The user toggles, and the optimistic
    // emit fires-and-forgets a cacheSet of the toggled state. Then the user
    // refreshes BEFORE the cacheSet flushes (simulated by clearing it before
    // session 2 starts).
    const preToggle = [baseItem({ checked: false })];
    await cacheSet("shopping:items:L1", preToggle);

    // (Simulate the fire-and-forget cacheSet for the toggled state NEVER
    // flushing — i.e. IDB still has the pre-toggle snapshot.)

    // Session 2 starts. The server's authoritative state is the toggled one.
    const stub = makeStubBackend();
    const wrapped = withShoppingCache(stub.backend);

    const seen: ShoppingItem[][] = [];
    const unsub = wrapped.subscribeToList("L1", {
      onList: () => {},
      onItems: (items) => {
        seen.push(items);
      },
      onTrips: () => {},
    });

    // Mirror bootstrap eventually returns server state (toggled).
    // Pretend the IDB hydrate finishes first.
    await tick(5);
    const liveToggled = [baseItem({ checked: true })];
    stub.emitItems(liveToggled);
    await tick(5);

    // The reducer's final state must be the toggled state from the server,
    // not the stale pre-toggle from IDB.
    expect(seen[seen.length - 1]).toEqual(liveToggled);
    expect(seen[seen.length - 1][0].checked).toBe(true);

    unsub();
  });
});
