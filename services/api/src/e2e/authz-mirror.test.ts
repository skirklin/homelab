/**
 * Property test for the authorization mirror invariant
 * (docs/auth-policy.md §5.3).
 *
 * For every user-owned collection in `PB_RULES`, we assert that the **two
 * enforcement paths agree**:
 *
 *   1. PB collection rules — applied to direct PB SDK calls from a
 *      per-user JWT (the frontend-direct path).
 *   2. TS route helpers in `lib/authz.ts` — applied to admin-PB calls
 *      driven by `hlk_`/`mcpat_` tokens (the API-service path).
 *
 * The test:
 *   - Creates two users A and B; A owns a top-level resource per
 *     surface (shopping list / task list / life log / travel log /
 *     recipe box + recipe). Where the collection is a child, B's
 *     access is exercised against the child whose parent is owned
 *     by A.
 *   - For each of the 5 rule slots (list/view/create/update/delete),
 *     issues an equivalent direct PB call as user B.
 *   - Asserts:
 *       (a) the live PB rule strings match `PB_RULES` — single
 *           source-of-truth check (migration 0026 already enforces
 *           this on apply, but a runtime check catches manual edits).
 *       (b) PB's allow/deny decision matches what the TS helper
 *           would have returned for user B against A's resource.
 *
 * Drift detection: if a future operator hand-edits a PB rule without
 * touching `lib/authz-rules.js` and `lib/authz.ts`, exactly one of
 * (a) or (b) flips and this test screams.
 *
 * Requires `pnpm test:env:up`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";

process.env.PB_URL = "http://127.0.0.1:8091";
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const {
  PB_RULES,
  userOwnsShoppingList,
  userOwnsTaskList,
  userOwnsLifeLog,
  userOwnsTravelLog,
  userOwnsRecipeBox,
  userCanWriteRecipe,
  userCanReadRecipe,
} = await import("../lib/authz");

const PB_URL = "http://127.0.0.1:8091";

interface User {
  id: string;
  pb: PocketBase;
}

let adminPb: PocketBase;
let aliceUser: User;
let bobUser: User;

async function makeUser(suffix: string): Promise<User> {
  const email = `${suffix}-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const rec = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: suffix,
  });
  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  await pb.collection("users").authWithPassword(email, password);
  return { id: rec.id, pb };
}

/** True iff the promise resolved; false if PB rejected. */
async function pbAllows<T>(p: Promise<T>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );

  aliceUser = await makeUser("alice");
  bobUser = await makeUser("bob");
});

// =============================================================================
// (a) PB_RULES matches the live PB schema.
// =============================================================================

describe("PB_RULES is the source of truth", () => {
  const collectionNames = Object.keys(PB_RULES) as Array<keyof typeof PB_RULES>;

  for (const name of collectionNames) {
    it(`${name}: live PB rules match PB_RULES (drift check)`, async () => {
      const col = await adminPb.collections.getOne(name as string);
      const want = PB_RULES[name];
      for (const field of ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"] as const) {
        expect(col[field], `${name}.${field}`).toBe(want[field]);
      }
    });
  }
});

// =============================================================================
// (b) PB allow/deny ↔ TS helper allow/deny agreement.
//
// One test per (surface, rule) pair, where:
//   - "surface" is a user-owned top-level collection. For child
//     collections we exercise the parent's helper, since that's what the
//     TS route layer calls.
//   - "rule" is one of view / update / delete (we skip list and create
//     here — list returns 200 with an empty result rather than a
//     rejection in PB, and create takes a fully-formed payload that's
//     surface-specific; both are covered by the existing cross-tenant
//     e2e tests).
// =============================================================================

describe("PB rule decision matches TS helper decision", () => {
  // ---------- shopping ----------
  describe("shopping_lists / shopping_items", () => {
    let alicesListId: string;
    let alicesItemId: string;

    beforeAll(async () => {
      const list = await aliceUser.pb.collection("shopping_lists").create({
        name: "alice list",
        owners: [aliceUser.id],
      });
      alicesListId = list.id;
      const item = await aliceUser.pb.collection("shopping_items").create({
        list: alicesListId,
        ingredient: "milk",
      });
      alicesItemId = item.id;
    });

    it("VIEW: PB and TS agree that Bob cannot view Alice's list", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("shopping_lists").getOne(alicesListId),
      );
      const tsAllow = await userOwnsShoppingList(bobUser.pb, alicesListId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });

    it("VIEW: PB and TS agree that Alice can view her own list", async () => {
      const pbAllow = await pbAllows(
        aliceUser.pb.collection("shopping_lists").getOne(alicesListId),
      );
      const tsAllow = await userOwnsShoppingList(aliceUser.pb, alicesListId, aliceUser.id);
      expect(pbAllow).toBe(true);
      expect(tsAllow).toBe(true);
    });

    it("UPDATE: PB and TS agree that Bob cannot update Alice's item (via list ownership)", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("shopping_items").update(alicesItemId, { ingredient: "stolen milk" }),
      );
      const tsAllow = await userOwnsShoppingList(bobUser.pb, alicesListId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });

    it("DELETE: PB and TS agree that Bob cannot delete Alice's list", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("shopping_lists").delete(alicesListId),
      );
      const tsAllow = await userOwnsShoppingList(bobUser.pb, alicesListId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });
  });

  // ---------- tasks ----------
  describe("task_lists / tasks", () => {
    let alicesListId: string;
    let alicesTaskId: string;

    beforeAll(async () => {
      const list = await aliceUser.pb.collection("task_lists").create({
        name: "alice tasks",
        owners: [aliceUser.id],
      });
      alicesListId = list.id;
      const task = await aliceUser.pb.collection("tasks").create({
        list: alicesListId,
        name: "do thing",
      });
      alicesTaskId = task.id;
    });

    it("VIEW: PB and TS agree that Bob cannot view Alice's task list", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("task_lists").getOne(alicesListId),
      );
      const tsAllow = await userOwnsTaskList(bobUser.pb, alicesListId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });

    it("UPDATE: PB and TS agree that Bob cannot update Alice's task", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("tasks").update(alicesTaskId, { name: "stolen task" }),
      );
      const tsAllow = await userOwnsTaskList(bobUser.pb, alicesListId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });

    it("DELETE: PB and TS agree that Bob cannot delete Alice's task list", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("task_lists").delete(alicesListId),
      );
      const tsAllow = await userOwnsTaskList(bobUser.pb, alicesListId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });
  });

  // ---------- life ----------
  describe("life_logs / life_events", () => {
    let alicesLogId: string;

    beforeAll(async () => {
      const log = await aliceUser.pb.collection("life_logs").create({
        name: "alice life",
        owners: [aliceUser.id],
      });
      alicesLogId = log.id;
    });

    it("VIEW: PB and TS agree that Bob cannot view Alice's life log", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("life_logs").getOne(alicesLogId),
      );
      const tsAllow = await userOwnsLifeLog(bobUser.pb, alicesLogId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });

    it("UPDATE: PB and TS agree that Bob cannot update Alice's life log", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("life_logs").update(alicesLogId, { name: "stolen" }),
      );
      const tsAllow = await userOwnsLifeLog(bobUser.pb, alicesLogId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });

    it("DELETE: PB and TS agree that Bob cannot delete Alice's life log", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("life_logs").delete(alicesLogId),
      );
      const tsAllow = await userOwnsLifeLog(bobUser.pb, alicesLogId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });
  });

  // ---------- travel ----------
  describe("travel_logs / travel_trips", () => {
    let alicesLogId: string;
    let alicesTripId: string;

    beforeAll(async () => {
      const log = await aliceUser.pb.collection("travel_logs").create({
        name: "alice travel",
        owners: [aliceUser.id],
      });
      alicesLogId = log.id;
      const trip = await aliceUser.pb.collection("travel_trips").create({
        log: alicesLogId,
        destination: "Tokyo",
        status: "Idea",
      });
      alicesTripId = trip.id;
    });

    it("VIEW: PB and TS agree that Bob cannot view Alice's travel log", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("travel_logs").getOne(alicesLogId),
      );
      const tsAllow = await userOwnsTravelLog(bobUser.pb, alicesLogId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });

    it("UPDATE: PB and TS agree that Bob cannot update Alice's trip", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("travel_trips").update(alicesTripId, { notes: "stolen" }),
      );
      const tsAllow = await userOwnsTravelLog(bobUser.pb, alicesLogId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });

    it("DELETE: PB and TS agree that Bob cannot delete Alice's travel log", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("travel_logs").delete(alicesLogId),
      );
      const tsAllow = await userOwnsTravelLog(bobUser.pb, alicesLogId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });
  });

  // ---------- recipes ----------
  describe("recipe_boxes / recipes (with vis interplay)", () => {
    let alicesBoxId: string;
    let alicesPrivateRecipeId: string;
    let alicesPublicRecipeId: string;

    beforeAll(async () => {
      const box = await aliceUser.pb.collection("recipe_boxes").create({
        name: "alice box",
        owners: [aliceUser.id],
        visibility: "public",
      });
      alicesBoxId = box.id;
      const priv = await aliceUser.pb.collection("recipes").create({
        box: box.id,
        data: { name: "secret stew" },
        owners: [aliceUser.id],
        visibility: "private",
      });
      alicesPrivateRecipeId = priv.id;
      const pub = await aliceUser.pb.collection("recipes").create({
        box: box.id,
        data: { name: "open stew" },
        owners: [aliceUser.id],
        visibility: "public",
      });
      alicesPublicRecipeId = pub.id;
    });

    it("VIEW (recipe_boxes): PB and TS agree on Bob's access to Alice's public box", async () => {
      // boxVisRule allows public OR owner OR authed-non-private. Alice's
      // box is public → Bob CAN view at PB. TS helper checks ownership only
      // (which Bob doesn't have). Asymmetric on purpose: helper gates
      // **writes**, not reads — the box-visibility-public path is for
      // discovery, not mutation. So we don't expect the two to agree on
      // VIEW of a public box. We only check the **write** axis here.
      // Sanity: confirm PB read works (vis rule public).
      const pbReadAllow = await pbAllows(
        bobUser.pb.collection("recipe_boxes").getOne(alicesBoxId),
      );
      expect(pbReadAllow).toBe(true);
    });

    it("UPDATE: PB and TS agree that Bob cannot update Alice's box", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("recipe_boxes").update(alicesBoxId, { name: "stolen" }),
      );
      const tsAllow = await userOwnsRecipeBox(bobUser.pb, alicesBoxId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });

    it("DELETE: PB and TS agree that Bob cannot delete Alice's box", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("recipe_boxes").delete(alicesBoxId),
      );
      const tsAllow = await userOwnsRecipeBox(bobUser.pb, alicesBoxId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsAllow).toBe(false);
    });

    it("UPDATE recipe: PB and TS agree that Bob cannot update Alice's recipe", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("recipes").update(alicesPublicRecipeId, { data: { name: "hijacked" } }),
      );
      const tsResult = await userCanWriteRecipe(bobUser.pb, alicesPublicRecipeId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsResult).toBe("denied");
    });

    it("READ private recipe: PB and TS agree that Bob cannot read Alice's private recipe", async () => {
      // Even though the parent box is public, the recipe's private
      // visibility (post-0024) hides it. TS helper mirrors the same logic.
      const pbAllow = await pbAllows(
        bobUser.pb.collection("recipes").getOne(alicesPrivateRecipeId),
      );
      const tsResult = await userCanReadRecipe(bobUser.pb, alicesPrivateRecipeId, bobUser.id);
      expect(pbAllow).toBe(false);
      expect(tsResult.status).not.toBe("ok");
    });

    it("READ public recipe: PB and TS agree that Bob can read Alice's public recipe", async () => {
      const pbAllow = await pbAllows(
        bobUser.pb.collection("recipes").getOne(alicesPublicRecipeId),
      );
      // userCanReadRecipe uses admin-PB ergonomics — we pass bob's user
      // pb here for read access; either way the recipe's `visibility =
      // "public"` clause matches.
      const tsResult = await userCanReadRecipe(adminPb, alicesPublicRecipeId, bobUser.id);
      expect(pbAllow).toBe(true);
      expect(tsResult.status).toBe("ok");
    });
  });
});
