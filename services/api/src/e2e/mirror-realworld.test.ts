/**
 * PBMirror real-world integration tests — against a live PocketBase.
 *
 * Complement to e2e/mirror.test.ts. The base suite covers single-session
 * correctness; this one covers the cross-session and adversarial scenarios
 * that bit in production (e.g. the shopping dogfood 404 on update).
 *
 * Each test names the scenario tag (A6, B1, etc.) corresponding to the
 * realworld unit-test catalog in packages/backend/src/wrapped-pb/realworld.test.ts.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";
import { EventSource } from "eventsource";
import { wrapPocketBase, persistMutation, clearAllMutations, newId } from "../../../../packages/backend/src/wrapped-pb/index";
import { createMirror, type RawRecord } from "../../../../packages/backend/src/wrapped-pb/mirror";
import type { PBMirror } from "../../../../packages/backend/src/wrapped-pb/mirror";
import { getPbTestUrl } from "./pb-test-url";

(globalThis as unknown as { EventSource: typeof EventSource }).EventSource = EventSource;

const PB_URL = getPbTestUrl();

let adminPb: PocketBase;
let aliceId: string;
let alicePb: PocketBase;
let aliceListId: string;

async function makeUser(suffix: string): Promise<{ id: string; pb: PocketBase }> {
  const email = `mirror-rw-${suffix}-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: `Mirror RW ${suffix}`,
  });
  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  await pb.collection("users").authWithPassword(email, password);
  return { id: user.id, pb };
}

// NOTE: the predicate is AWAITED. src/e2e is excluded from tsc (tsconfig
// `exclude`), so a sync-only signature here would silently accept an async
// predicate whose returned Promise is always truthy — waitFor would return
// immediately without polling. That exact bug made A2's "PB has the record"
// wait a no-op, letting the cleanup delete race the replayed create POST.
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
  ({ id: aliceId, pb: alicePb } = await makeUser("alice"));

  const list = await alicePb.collection("shopping_lists").create({
    name: "Mirror RW List",
    owners: [aliceId],
    category_defs: [],
  });
  aliceListId = list.id;
}, 60000);

afterAll(async () => {
  try {
    const items = await alicePb.collection("shopping_items").getFullList({
      filter: alicePb.filter("list = {:listId}", { listId: aliceListId }),
      $autoCancel: false,
    });
    for (const i of items) {
      try { await alicePb.collection("shopping_items").delete(i.id); } catch { /* ignore */ }
    }
    try { await alicePb.collection("shopping_lists").delete(aliceListId); } catch { /* ignore */ }
  } catch { /* ignore */ }
  await clearAllMutations();
});

describe("PBMirror integration: page-reload boundary (dogfood)", () => {
  it("A1: original POST landed; replay-create returns 409; mirror stays consistent and update succeeds", async () => {
    await clearAllMutations();

    // Pre-seed a record on PB (simulating "session 1 created it and PB
    // acked, but IDB persist never cleared before tab closed").
    const itemId = newId();
    await alicePb.collection("shopping_items").create({
      id: itemId,
      list: aliceListId,
      ingredient: "test",
      note: "",
      category_id: "uncategorized",
      checked: false,
      added_by: aliceId,
    });
    // Persist a stale "create" mutation referencing this id.
    await persistMutation({
      id: newId(),
      collection: "shopping_items",
      recordId: itemId,
      mutation: {
        kind: "set",
        record: {
          id: itemId,
          list: aliceListId,
          ingredient: "test",
          note: "",
          category_id: "uncategorized",
          checked: false,
          added_by: aliceId,
        },
      },
      createdAt: Date.now() - 1000,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => alicePb);
    const mirror: PBMirror = createMirror(() => alicePb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      {
        collection: "shopping_items",
        topic: "*",
        filter: alicePb.filter("list = {:listId}", { listId: aliceListId }),
        predicate: (r) => r.list === aliceListId,
      },
      (s) => { states.push(s); },
    );

    try {
      await waitFor(() => states.some((s) => s.some((r) => r.id === itemId)));

      // Fire replayPending — the create POST will hit PB and 409.
      await wpb.replayPending();
      // Wait for the replay to settle.
      await new Promise((r) => setTimeout(r, 500));

      // Mirror still has the record.
      expect(states[states.length - 1].map((r) => r.id)).toContain(itemId);

      // User clicks check — should succeed (PB has the record).
      let updateErr: unknown = null;
      try {
        await wpb.collection("shopping_items").update(itemId, { checked: true });
      } catch (err) {
        updateErr = err;
      }
      expect(updateErr).toBeNull();

      // Cleanup
      await alicePb.collection("shopping_items").delete(itemId);
    } finally {
      handle.unsubscribe();
      mirror.dispose();
    }
  }, 30000);

  it("A6 (DOGFOOD against real PB): persisted create + immediate user update → no 404", async () => {
    await clearAllMutations();

    // PB does NOT have this record (simulate "session 1 closed before
    // create POST left"). IDB has the persisted create.
    const itemId = newId();
    const mutId = newId();
    await persistMutation({
      id: mutId,
      collection: "shopping_items",
      recordId: itemId,
      mutation: {
        kind: "set",
        record: {
          id: itemId,
          list: aliceListId,
          ingredient: "test-a6",
          note: "",
          category_id: "uncategorized",
          checked: false,
          added_by: aliceId,
        },
      },
      createdAt: Date.now() - 1000,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => alicePb);
    const mirror: PBMirror = createMirror(() => alicePb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      {
        collection: "shopping_items",
        topic: "*",
        filter: alicePb.filter("list = {:listId}", { listId: aliceListId }),
        predicate: (r) => r.list === aliceListId,
      },
      (s) => { states.push(s); },
    );

    try {
      await waitFor(() => states.length > 0);

      // Production ordering: BackendProvider fires replayPending in useEffect.
      void wpb.replayPending();
      // The user sees the optimistic row.
      await waitFor(() => states[states.length - 1].some((r) => r.id === itemId));

      // User immediately clicks check. This is the dogfood click that 404'd.
      // With the per-record dispatch chain it should be serialized after
      // the replay's create POST.
      let updateErr: unknown = null;
      try {
        await wpb.collection("shopping_items").update(itemId, { checked: true });
      } catch (err) {
        updateErr = err;
      }

      expect(
        updateErr,
        "user-driven update behind a replayed create must not throw a 404 against real PB",
      ).toBeNull();

      // Verify PB has the record with checked=true.
      const final = await alicePb.collection("shopping_items").getOne(itemId);
      expect(final.checked).toBe(true);

      // Cleanup
      await alicePb.collection("shopping_items").delete(itemId);
    } finally {
      handle.unsubscribe();
      mirror.dispose();
    }
  }, 30000);

  it("A11 (DOGFOOD oscillation): stale persisted SET + server has checked=true → consumer must never see checked=false", async () => {
    // Live-PB version of realworld.test.ts:A11. The user's exact repro:
    //   1. add item → server has checked=false
    //   2. check item → server now has checked=true; both pending acks
    //      drain, but the SET's IDB unpersist is fire-and-forget. If the
    //      user refreshes within a few ms, the SET entry is still in IDB.
    //   3. refresh → session 2 boots:
    //        - BackendProvider fires replayPending. SET is pushed into
    //          the queue; POST dispatched (will 409).
    //        - Mirror.watch bootstraps via getFullList → fetches server
    //          {checked: true}.
    //   4. Without the fix, composeView(server={checked:true}, [set{checked:false}])
    //      = {checked:false} because `set` REPLACED the server snapshot.
    //      Consumer observes unchecked, then the 409 drains and the record
    //      disappears entirely.
    //   5. With the fix, `set` is a no-op when a server snapshot exists,
    //      so the consumer never sees checked=false.
    await clearAllMutations();
    const itemId = newId();

    // Server reflects the post-check state (the user's real intent).
    await alicePb.collection("shopping_items").create({
      id: itemId,
      list: aliceListId,
      ingredient: "test-a11",
      note: "",
      category_id: "uncategorized",
      checked: true,
      checked_by: aliceId,
      checked_at: new Date().toISOString(),
      added_by: aliceId,
    });

    // IDB still has the stale SET from session 1 (create-time body: checked=false).
    await persistMutation({
      id: newId(),
      collection: "shopping_items",
      recordId: itemId,
      mutation: {
        kind: "set",
        record: {
          id: itemId,
          list: aliceListId,
          ingredient: "test-a11",
          note: "",
          category_id: "uncategorized",
          checked: false,
          added_by: aliceId,
        },
      },
      createdAt: Date.now() - 1000,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => alicePb);

    // Production ordering: replayPending fires before mirror.watch attaches.
    void wpb.replayPending();

    const mirror: PBMirror = createMirror(() => alicePb, wpb);
    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      {
        collection: "shopping_items",
        topic: "*",
        filter: alicePb.filter("list = {:listId}", { listId: aliceListId }),
        predicate: (r) => r.list === aliceListId,
      },
      (s) => { states.push(s); },
    );

    try {
      // Wait for the replay's POST (which will 400/409 against PB because
      // the record already exists) to settle.
      await new Promise((r) => setTimeout(r, 750));

      // INVARIANT 1: no emit ever showed the item as unchecked.
      const checkedHistory = states
        .map((s) => s.find((r) => r.id === itemId)?.checked)
        .filter((v) => v !== undefined);
      expect(
        checkedHistory,
        `no emit may surface checked=false; observed: ${JSON.stringify(checkedHistory)}`,
      ).not.toContain(false);

      // INVARIANT 2: final state has the record present and checked=true.
      const finalState = states[states.length - 1] ?? [];
      const finalItem = finalState.find((r) => r.id === itemId);
      expect(finalItem, "record must remain in mirror view").toBeDefined();
      expect(finalItem?.checked).toBe(true);

      // INVARIANT 3: server state still consistent (replay's POST didn't
      // mutate server truth).
      const onServer = await alicePb.collection("shopping_items").getOne(itemId);
      expect(onServer.checked).toBe(true);

      await alicePb.collection("shopping_items").delete(itemId);
    } finally {
      handle.unsubscribe();
      mirror.dispose();
    }
  }, 30000);

  it("A2: persisted create with no prior PB record → replay creates the record, mirror reflects it", async () => {
    await clearAllMutations();
    const itemId = newId();
    await persistMutation({
      id: newId(),
      collection: "shopping_items",
      recordId: itemId,
      mutation: {
        kind: "set",
        record: {
          id: itemId,
          list: aliceListId,
          ingredient: "test-a2",
          note: "",
          category_id: "uncategorized",
          checked: false,
          added_by: aliceId,
        },
      },
      createdAt: Date.now() - 1000,
      origin: "tab-1",
    });

    const wpb = wrapPocketBase(() => alicePb);
    const mirror: PBMirror = createMirror(() => alicePb, wpb);

    const states: RawRecord[][] = [];
    const handle = mirror.watch(
      {
        collection: "shopping_items",
        topic: "*",
        filter: alicePb.filter("list = {:listId}", { listId: aliceListId }),
        predicate: (r) => r.list === aliceListId,
      },
      (s) => { states.push(s); },
    );

    try {
      await waitFor(() => states.length > 0);

      await wpb.replayPending();
      // After replay, PB has the record.
      await waitFor(async () => {
        try {
          await alicePb.collection("shopping_items").getOne(itemId);
          return true;
        } catch {
          return false;
        }
      });

      // Mirror reflects the create.
      expect(states[states.length - 1].some((r) => r.id === itemId)).toBe(true);

      await alicePb.collection("shopping_items").delete(itemId);
    } finally {
      handle.unsubscribe();
      mirror.dispose();
    }
  }, 30000);
});

describe("PBMirror integration: dispatch-chain serialization against real PB", () => {
  it("A9: create + immediate update on same id — both succeed, final state has the update applied", async () => {
    await clearAllMutations();
    const wpb = wrapPocketBase(() => alicePb);
    const itemId = newId();

    // Fire create + update in the same tick (no await between).
    const p1 = wpb.collection("shopping_items").create({
      id: itemId,
      list: aliceListId,
      ingredient: "a9-create",
      note: "",
      category_id: "uncategorized",
      checked: false,
      added_by: aliceId,
    });
    const p2 = wpb.collection("shopping_items").update(itemId, { checked: true });

    let err1: unknown = null;
    let err2: unknown = null;
    try { await p1; } catch (e) { err1 = e; }
    try { await p2; } catch (e) { err2 = e; }

    expect(err1).toBeNull();
    expect(err2, "update on a freshly-created record must not race against PB").toBeNull();

    const final = await alicePb.collection("shopping_items").getOne(itemId);
    expect(final.checked).toBe(true);

    await alicePb.collection("shopping_items").delete(itemId);
  }, 30000);
});

describe("PBMirror integration: dogfood toggle sequence", () => {
  it("create → check → uncheck → reload → check: all succeed end-to-end", async () => {
    // This is the actual user-facing flow from the dogfood bug. Mirror
    // and wpb survive a simulated reload (clear in-memory queue, leave
    // IDB; new wpb instance replays from IDB).
    await clearAllMutations();
    const itemId = newId();

    // SESSION 1
    let wpb1 = wrapPocketBase(() => alicePb);
    {
      // create
      await wpb1.collection("shopping_items").create({
        id: itemId,
        list: aliceListId,
        ingredient: "dogfood",
        note: "",
        category_id: "uncategorized",
        checked: false,
        added_by: aliceId,
      });
      // check
      await wpb1.collection("shopping_items").update(itemId, {
        checked: true,
        checked_by: aliceId,
        checked_at: new Date().toISOString(),
      });
      // uncheck
      await wpb1.collection("shopping_items").update(itemId, {
        checked: false,
        checked_by: "",
        checked_at: "",
      });
    }
    void wpb1;

    // SIMULATED RELOAD: throw away the wpb/mirror, create fresh ones.
    // IDB persists across the reload (in-memory map is wiped). Persisted
    // entries should be drained-by-ack so IDB is empty — but if not, the
    // replay must converge to a working state.
    const wpb2 = wrapPocketBase(() => alicePb);
    const mirror2 = createMirror(() => alicePb, wpb2);

    const states: RawRecord[][] = [];
    const handle = mirror2.watch(
      {
        collection: "shopping_items",
        topic: "*",
        filter: alicePb.filter("list = {:listId}", { listId: aliceListId }),
        predicate: (r) => r.list === aliceListId,
      },
      (s) => { states.push(s); },
    );

    try {
      await waitFor(() => states.length > 0);
      // Bootstrap saw the record.
      expect(states[states.length - 1].some((r) => r.id === itemId)).toBe(true);

      await wpb2.replayPending();
      await new Promise((r) => setTimeout(r, 200));

      // CHECK after reload — must not 404.
      let updateErr: unknown = null;
      try {
        await wpb2.collection("shopping_items").update(itemId, {
          checked: true,
          checked_by: aliceId,
          checked_at: new Date().toISOString(),
        });
      } catch (err) {
        updateErr = err;
      }
      expect(updateErr, "check-after-reload must not 404").toBeNull();

      const final = await alicePb.collection("shopping_items").getOne(itemId);
      expect(final.checked).toBe(true);

      await alicePb.collection("shopping_items").delete(itemId);
    } finally {
      handle.unsubscribe();
      mirror2.dispose();
    }
  }, 30000);
});
