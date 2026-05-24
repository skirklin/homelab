/**
 * Reproduces the beta.kirkl.in bug where toggling a shopping item, then
 * refreshing the page, shows the item rolled back to the pre-toggle state.
 *
 * The hypothesis was that the cache decorator (packages/backend/src/cache/shopping.ts)
 * + helpers (cache/helpers.ts) write subscription emits to IDB on every
 * callback (fire-and-forget cacheSet), and on next mount the hydrateOne path
 * serves a stale snapshot. The reducer applies that stale snapshot, then the
 * mirror's live emit arrives later and converges — UNLESS there's a path
 * where the cache emit fires AFTER the mirror's emit (clobbering it) or
 * the mirror's emit never arrives.
 *
 * This test exercises the full stack against real PB so we don't elide
 * timing the way a stubbed inner backend would.
 *
 * Run: pnpm --filter @homelab/api test src/e2e/shopping-cache-refresh.test.ts
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";
import { EventSource } from "eventsource";

import { wrapPocketBase, clearAllMutations, loadAllMutations, newId } from "../../../../packages/backend/src/wrapped-pb/index";
import { createMirror } from "../../../../packages/backend/src/wrapped-pb/mirror";
import { PocketBaseShoppingBackend } from "../../../../packages/backend/src/pocketbase/shopping";
import { withShoppingCache } from "../../../../packages/backend/src/cache/shopping";
import { cacheClear } from "../../../../packages/backend/src/cache/storage";
import type { ShoppingBackend } from "../../../../packages/backend/src/interfaces/shopping";
import type { ShoppingItem } from "../../../../packages/backend/src/types/shopping";

(globalThis as unknown as { EventSource: typeof EventSource }).EventSource = EventSource;

const PB_URL = "http://127.0.0.1:8091";

let adminPb: PocketBase;
let userId: string;
let userPb: PocketBase;
let listId: string;

async function makeUser(): Promise<{ id: string; pb: PocketBase }> {
  const email = `cache-refresh-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: "Cache Refresh",
  });
  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  await pb.collection("users").authWithPassword(email, password);
  return { id: user.id, pb };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );
  ({ id: userId, pb: userPb } = await makeUser());

  const list = await userPb.collection("shopping_lists").create({
    name: "Cache Refresh List",
    owners: [userId],
    category_defs: [],
  });
  listId = list.id;
}, 60000);

afterAll(async () => {
  try {
    const items = await userPb.collection("shopping_items").getFullList({
      filter: userPb.filter("list = {:listId}", { listId }),
      $autoCancel: false,
    });
    for (const i of items) {
      try { await userPb.collection("shopping_items").delete(i.id); } catch { /* ignore */ }
    }
    try { await userPb.collection("shopping_lists").delete(listId); } catch { /* ignore */ }
  } catch { /* ignore */ }
  await clearAllMutations();
  await cacheClear();
});

/** Build the full backend stack the way BackendProvider does in browser. */
function makeStack(pb: PocketBase): {
  shopping: ShoppingBackend;
  wpb: ReturnType<typeof wrapPocketBase>;
  teardown: () => void;
} {
  const wpb = wrapPocketBase(() => pb);
  const mirror = createMirror(() => pb, wpb);
  const inner = new PocketBaseShoppingBackend(() => pb, wpb, mirror);
  const cached = withShoppingCache(inner);
  return {
    shopping: cached,
    wpb,
    teardown: () => { mirror.dispose(); },
  };
}

describe("shopping refresh — cache + mirror convergence against real PB", () => {
  it("REPRO: toggle item, simulate refresh, expect final state to reflect server (not stale cache)", async () => {
    await clearAllMutations();
    await cacheClear();

    // -------- Session 1: load list, then toggle an item --------
    const session1 = makeStack(userPb);

    // Seed an item directly on the server (representing prior session state).
    const itemId = newId();
    await userPb.collection("shopping_items").create({
      id: itemId,
      list: listId,
      ingredient: "milk",
      note: "",
      category_id: "uncategorized",
      checked: false,
      added_by: userId,
    });

    const s1Emits: ShoppingItem[][] = [];
    const s1Unsub = session1.shopping.subscribeToList(listId, {
      onList: () => {},
      onItems: (items) => { s1Emits.push(items); },
      onHistory: () => {},
      onTrips: () => {},
    });

    // Wait for initial emit (mirror bootstrap returns the seeded item).
    await waitFor(() => s1Emits.some((s) => s.some((i) => i.id === itemId)));

    // User toggles checked=true. Don't await — fire-and-forget like the UI.
    void session1.shopping.toggleItem(itemId, true, userId);

    // Wait for the optimistic emit to reflect checked=true.
    await waitFor(() => {
      const last = s1Emits[s1Emits.length - 1];
      return last?.some((i) => i.id === itemId && i.checked === true) ?? false;
    });

    // Tear down session 1 — but DO NOT wait for cacheSet flushes or wpb
    // ack to complete. This is the "fast refresh" the user reports.
    s1Unsub();
    session1.teardown();

    // -------- Server-side verification: server reflects the toggle --------
    // Give the in-flight POST a moment to land (it shouldn't be blocked by
    // anything; wpb fires it inline).
    await waitFor(async () => {
      try {
        const r = await userPb.collection("shopping_items").getOne(itemId);
        return r.checked === true;
      } catch { return false; }
    }, 5000);

    const serverAfterToggle = await userPb.collection("shopping_items").getOne(itemId);
    expect(serverAfterToggle.checked, "server must reflect the toggle").toBe(true);

    // -------- Session 2: page refresh — new wpb/mirror, same IDB --------
    const session2 = makeStack(userPb);

    const s2Emits: ShoppingItem[][] = [];
    const s2Unsub = session2.shopping.subscribeToList(listId, {
      onList: () => {},
      onItems: (items) => { s2Emits.push(items); },
      onHistory: () => {},
      onTrips: () => {},
    });

    // Production ordering: BackendProvider fires replayPending in useEffect.
    // It's safe to call after subscribe attaches.
    const wpb2 = (session2.shopping as unknown as { __wpb?: unknown }); // not directly accessible
    void wpb2; // placeholder for code clarity — we use loadAllMutations to check IDB

    // Give the mirror time to bootstrap and converge.
    await waitFor(() => s2Emits.length > 0, 5000);
    // Extra wait in case the cache hydrate fires later than the live emit
    // and clobbers it (the suspected bug).
    await new Promise((r) => setTimeout(r, 500));

    const finalEmit = s2Emits[s2Emits.length - 1];
    const finalItem = finalEmit.find((i) => i.id === itemId);

    expect(finalItem, "item must be present in final emit").toBeDefined();
    expect(
      finalItem?.checked,
      "after refresh, item.checked must reflect the toggled (server-truth) state, not stale cache",
    ).toBe(true);

    s2Unsub();
    session2.teardown();

    // Cleanup
    try { await userPb.collection("shopping_items").delete(itemId); } catch { /* ignore */ }
  }, 30000);

  it("REPRO 2: toggle then immediate refresh BEFORE server ack (queue must replay correctly)", async () => {
    await clearAllMutations();
    await cacheClear();

    const session1 = makeStack(userPb);

    // Seed an item.
    const itemId = newId();
    await userPb.collection("shopping_items").create({
      id: itemId,
      list: listId,
      ingredient: "eggs",
      note: "",
      category_id: "uncategorized",
      checked: false,
      added_by: userId,
    });

    const s1Emits: ShoppingItem[][] = [];
    const s1Unsub = session1.shopping.subscribeToList(listId, {
      onList: () => {},
      onItems: (items) => { s1Emits.push(items); },
      onHistory: () => {},
      onTrips: () => {},
    });

    await waitFor(() => s1Emits.some((s) => s.some((i) => i.id === itemId)));

    // Fire toggle and IMMEDIATELY tear down — before server ack.
    void session1.shopping.toggleItem(itemId, true, userId);

    // Wait only for the optimistic emit, then tear down.
    await waitFor(() => {
      const last = s1Emits[s1Emits.length - 1];
      return last?.some((i) => i.id === itemId && i.checked === true) ?? false;
    });
    s1Unsub();
    session1.teardown();

    // Check whether the mutation is still in IDB (it might be — fast refresh
    // before unpersist).
    const persisted = await loadAllMutations();
    const haveStaleMutation = persisted.some(
      (m) => m.collection === "shopping_items" && m.recordId === itemId,
    );
    console.log(`[repro2] persisted mutations after fast refresh: ${persisted.length}, stale-for-target: ${haveStaleMutation}`);

    // -------- Session 2: page refresh --------
    const session2 = makeStack(userPb);

    // Mirror replays pending mutations (production ordering — BackendProvider
    // calls replayPending in useEffect, parallel to subscriptions).
    // CRITICAL: replay must go through the SAME wpb the stack uses, otherwise
    // the queue overlay used by the mirror's materialize() is invisible to it.
    void session2.wpb.replayPending();

    const s2Emits: ShoppingItem[][] = [];
    const s2Unsub = session2.shopping.subscribeToList(listId, {
      onList: () => {},
      onItems: (items) => { s2Emits.push(items); },
      onHistory: () => {},
      onTrips: () => {},
    });

    await waitFor(() => s2Emits.length > 0, 5000);
    await new Promise((r) => setTimeout(r, 500));

    const final = s2Emits[s2Emits.length - 1].find((i) => i.id === itemId);
    expect(final, "item must be present after refresh").toBeDefined();
    expect(
      final?.checked,
      "after fast refresh, item must end up checked — the user's intent must not be lost",
    ).toBe(true);

    s2Unsub();
    session2.teardown();
    try { await userPb.collection("shopping_items").delete(itemId); } catch { /* ignore */ }
  }, 30000);
});
