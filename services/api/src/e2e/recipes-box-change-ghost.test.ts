/**
 * Recipes regression: the "box-change ghost" bug, against a live PocketBase.
 *
 * Legacy behavior (`packages/backend/src/pocketbase/recipes.ts`, pre-mirror):
 *   subscribeToUser opened one wildcard PB SSE per subscribed box, and on
 *   each event filtered with a hand-rolled `r.box === boxId` predicate.
 *   When a recipe moved from boxA to boxB, the SSE update event for the
 *   recipe arrived with the NEW `box = boxB` payload. The old box's
 *   listener tested `boxB === boxA` → false, treated the event as
 *   not-for-me, and emitted nothing. The recipe stayed visible in boxA
 *   forever — a ghost — until a full reload re-fetched recipes by filter.
 *
 * Mirror behavior (post-8e920a8):
 *   Each box's slice is a filter-scoped mirror watch with `predicate:
 *   r => r.box === boxId`. The mirror re-runs the predicate over the full
 *   raw-record set on every state change, so a record whose `box` field
 *   flipped naturally:
 *     - fails the old slice's predicate → emitted as a removal
 *     - passes the new slice's predicate → emitted as an addition
 *   No special-case "did the foreign key change?" logic needed.
 *
 * This test exercises both directions (A→B and B→A) so the predicate
 * round-trips against real SSE delivery, not just a stubbed mirror.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";
import { EventSource } from "eventsource";
import { wrapPocketBase, clearAllMutations } from "../../../../packages/backend/src/wrapped-pb/index";
import { createMirror } from "../../../../packages/backend/src/wrapped-pb/mirror";
import { PocketBaseRecipesBackend } from "../../../../packages/backend/src/pocketbase/recipes";
import type { Recipe, RecipeBox } from "../../../../packages/backend/src/types/recipes";

(globalThis as unknown as { EventSource: typeof EventSource }).EventSource = EventSource;

const PB_URL = process.env.PB_URL ?? "http://127.0.0.1:8091";

let adminPb: PocketBase;
let userId: string;
let userPb: PocketBase;
let boxAId: string;
let boxBId: string;
let recipeId: string;

async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
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

  const email = `box-ghost-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: "Ghost Test",
  });
  userId = user.id;
  userPb = new PocketBase(PB_URL);
  userPb.autoCancellation(false);
  await userPb.collection("users").authWithPassword(email, password);

  const boxA = await adminPb.collection("recipe_boxes").create({
    name: "Box A",
    owners: [userId],
    visibility: "private",
    creator: userId,
  });
  boxAId = boxA.id;
  const boxB = await adminPb.collection("recipe_boxes").create({
    name: "Box B",
    owners: [userId],
    visibility: "private",
    creator: userId,
  });
  boxBId = boxB.id;
  await adminPb.collection("users").update(userId, { recipe_boxes: [boxAId, boxBId] });

  const recipe = await adminPb.collection("recipes").create({
    box: boxAId,
    data: { "@type": "Recipe", name: "Migrating Recipe" },
    owners: [userId],
    visibility: "private",
    creator: userId,
    enrichment_status: "needed",
  });
  recipeId = recipe.id;
}, 60000);

afterAll(async () => {
  try { await adminPb.collection("recipes").delete(recipeId); } catch { /* ignore */ }
  try { await adminPb.collection("recipe_boxes").delete(boxAId); } catch { /* ignore */ }
  try { await adminPb.collection("recipe_boxes").delete(boxBId); } catch { /* ignore */ }
  try { await adminPb.collection("users").delete(userId); } catch { /* ignore */ }
  await clearAllMutations();
});

describe("Recipes: recipe-box-change ghost bug (PBMirror regression)", () => {
  it("moves a recipe between boxes via SSE — old slice empties, new slice receives it (both directions)", async () => {
    await clearAllMutations();
    const pb = () => userPb;
    const wpb = wrapPocketBase(pb);
    const mirror = createMirror(pb, wpb);
    const recipes = new PocketBaseRecipesBackend(pb, wpb, mirror);

    // Per-box latest emit (rebuilt on every onRecipes / onBox call). onBox
    // also delivers the initial recipes batch, so we seed from it.
    const latest = new Map<string, Recipe[]>();
    const initialBoxes = new Map<string, RecipeBox>();

    const unsub = recipes.subscribeToUser(userId, {
      onUser: () => { /* no-op */ },
      onBox: (box, rs) => {
        initialBoxes.set(box.id, box);
        latest.set(box.id, rs);
      },
      onBoxRemoved: (boxId) => { latest.delete(boxId); },
      onRecipes: (boxId, rs) => { latest.set(boxId, rs); },
    });

    try {
      // Wait for both initial onBox emits + initial recipes for each.
      await waitFor(() => initialBoxes.has(boxAId) && initialBoxes.has(boxBId));
      expect(latest.get(boxAId)?.map((r) => r.id)).toEqual([recipeId]);
      expect(latest.get(boxBId)?.map((r) => r.id) ?? []).toEqual([]);

      // Wait for SSE to fully connect before mutating server-side.
      await waitFor(() => userPb.realtime.isConnected === true, 5000);
      await new Promise((r) => setTimeout(r, 100));

      // ── A → B ────────────────────────────────────────────────────────
      // The legacy implementation would drop this SSE event on box A's
      // listener (predicate sees `box=boxB` and rejects it), leaving the
      // recipe as a ghost in box A's view.
      await adminPb.collection("recipes").update(recipeId, { box: boxBId });

      await waitFor(
        () =>
          (latest.get(boxAId)?.length ?? -1) === 0 &&
          latest.get(boxBId)?.some((r) => r.id === recipeId) === true,
      );
      expect(latest.get(boxAId)).toEqual([]);
      expect(latest.get(boxBId)?.map((r) => r.id)).toEqual([recipeId]);

      // ── B → A (round-trip) ───────────────────────────────────────────
      // Same bug, opposite direction. Locks the predicate's symmetry.
      await adminPb.collection("recipes").update(recipeId, { box: boxAId });

      await waitFor(
        () =>
          (latest.get(boxBId)?.length ?? -1) === 0 &&
          latest.get(boxAId)?.some((r) => r.id === recipeId) === true,
      );
      expect(latest.get(boxBId)).toEqual([]);
      expect(latest.get(boxAId)?.map((r) => r.id)).toEqual([recipeId]);
    } finally {
      unsub();
      mirror.dispose();
    }
  }, 30000);
});
