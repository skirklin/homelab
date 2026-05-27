/**
 * Regression test for cross-tenant reads/writes via `/data/{boxes,recipes,
 * cooking-log}` routes.
 *
 * Same admin-PB-bypass shape as cross-tenant-data-routes.test.ts (travel).
 * `hlk_`/`mcpat_` tokens auth against a superuser PB client; that client
 * ignores PB collection rules entirely, so migration 0024's tightened
 * rules don't help here — route-level checks are the only thing standing
 * between an attacker's token and a victim's recipe box.
 *
 * GET /data/recipes/:id was also leaking *any* recipe by ID — there was
 * no ownership check at all. That smoking gun is in `leak_get_recipe`.
 *
 * Requires `pnpm test:env:up`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";

process.env.PB_URL = process.env.PB_URL ?? "http://127.0.0.1:8091";
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const { default: { app } } = await import("../test-app");

const PB_URL = process.env.PB_URL ?? "http://127.0.0.1:8091";

interface Actor {
  id: string;
  email: string;
  userJwt: string;
  apiToken: string;
}

let adminPb: PocketBase;
let alice: Actor;
let bob: Actor;
let bobsBoxId: string;
let bobsPrivateRecipeId: string;
let bobsPublicRecipeId: string;
let bobsCookingLogId: string;
let alicesBoxId: string;

async function makeActor(suffix: string): Promise<Actor> {
  const email = `${suffix}-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: suffix,
  });
  const userPb = new PocketBase(PB_URL);
  userPb.autoCancellation(false);
  await userPb.collection("users").authWithPassword(email, password);

  const tokenResp = await app.request("/auth/tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${userPb.authStore.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: `${suffix}-test-token` }),
  });
  const tokenData = await tokenResp.json() as { token: string };

  return {
    id: user.id,
    email,
    userJwt: userPb.authStore.token,
    apiToken: tokenData.token,
  };
}

async function apiReq(
  path: string,
  opts: { method?: string; token: string; body?: unknown },
): Promise<{ status: number; data: unknown }> {
  const resp = await app.request(path, {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: resp.status, data: await resp.json().catch(() => null) };
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );

  alice = await makeActor("alice");
  bob = await makeActor("bob");

  // Bob owns a private recipe_box with one private recipe + one public recipe
  // and one cooking-log entry on the private recipe.
  const bobPb = new PocketBase(PB_URL);
  bobPb.autoCancellation(false);
  bobPb.authStore.save(bob.userJwt, null);

  const bobsBox = await bobPb.collection("recipe_boxes").create({
    name: "Bob's box",
    visibility: "private",
    owners: [bob.id],
  });
  bobsBoxId = bobsBox.id;

  const bobsPrivateRecipe = await bobPb.collection("recipes").create({
    box: bobsBoxId,
    data: { name: "Bob's private recipe", recipeIngredient: ["flour"], recipeInstructions: [{ "@type": "HowToStep", text: "mix" }] },
    owners: [bob.id],
    visibility: "private",
    enrichment_status: "done",
  });
  bobsPrivateRecipeId = bobsPrivateRecipe.id;

  const bobsPublicRecipe = await bobPb.collection("recipes").create({
    box: bobsBoxId,
    data: { name: "Bob's public recipe", recipeIngredient: [], recipeInstructions: [] },
    owners: [bob.id],
    visibility: "public",
    enrichment_status: "done",
  });
  bobsPublicRecipeId = bobsPublicRecipe.id;

  const event = await bobPb.collection("recipe_events").create({
    box: bobsBoxId,
    subject_id: bobsPrivateRecipeId,
    timestamp: new Date().toISOString(),
    created_by: bob.id,
    entries: [{ name: "notes", type: "text", value: "bob cooked it" }],
  });
  bobsCookingLogId = event.id;

  // Alice's own box, used to verify legitimate operations still work and to
  // attempt a reparenting attack (move Bob's recipe into Alice's box).
  const alicePb = new PocketBase(PB_URL);
  alicePb.autoCancellation(false);
  alicePb.authStore.save(alice.userJwt, null);
  const alicesBox = await alicePb.collection("recipe_boxes").create({
    name: "Alice's box",
    visibility: "private",
    owners: [alice.id],
  });
  alicesBoxId = alicesBox.id;
});

describe("cross-tenant access via /data/recipes/* (admin-PB bypass)", () => {
  // ---- Reads ----

  it("blocks Alice's hlk_ token from GETing Bob's PRIVATE recipe by ID", async () => {
    // Smoking gun: pre-fix GET /data/recipes/:id had no ownership check;
    // Alice's token retrieved Bob's private recipe in full.
    const { status, data } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}`, {
      token: alice.apiToken,
    });
    expect(
      status,
      `Alice was able to GET Bob's private recipe; body: ${JSON.stringify(data)}`,
    ).not.toBe(200);
    expect([403, 404]).toContain(status);
  });

  it("still lets anyone GET Bob's PUBLIC recipe", async () => {
    const { status, data } = await apiReq(`/data/recipes/${bobsPublicRecipeId}`, {
      token: alice.apiToken,
    });
    expect(status).toBe(200);
    expect((data as { id: string }).id).toBe(bobsPublicRecipeId);
  });

  it("still lets Bob GET his own private recipe", async () => {
    const { status, data } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}`, {
      token: bob.apiToken,
    });
    expect(status).toBe(200);
    expect((data as { id: string }).id).toBe(bobsPrivateRecipeId);
  });

  // ---- Box writes ----

  it("blocks Alice from PATCHing Bob's box", async () => {
    const { status } = await apiReq(`/data/boxes/${bobsBoxId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { name: "hijacked box" },
    });
    expect(status, "Alice was able to mutate Bob's box").toBe(403);
  });

  it("blocks Alice from POST /data/recipes-ing into Bob's box", async () => {
    const { status } = await apiReq("/data/recipes", {
      method: "POST",
      token: alice.apiToken,
      body: { boxId: bobsBoxId, data: { name: "phantom recipe" } },
    });
    expect(status, "Alice was able to plant a recipe in Bob's box").toBe(403);
  });

  // ---- Recipe writes ----

  it("blocks Alice from PATCHing Bob's recipe data", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { data: { name: "hijacked recipe" } },
    });
    expect(status, "Alice was able to mutate Bob's recipe").toBe(403);
  });

  it("blocks Alice from PATCHing Bob's recipe visibility", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { visibility: "public" },
    });
    expect(status, "Alice was able to expose Bob's private recipe").toBe(403);
  });

  it("blocks Alice from PATCH-reparenting Bob's recipe into her box", async () => {
    // Pre-fix the body went verbatim through `patch`, so `box` would have
    // been writable — effectively letting Alice steal a recipe.
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { box: alicesBoxId, data: { name: "stolen" } },
    });
    expect(status, "Alice was able to reparent Bob's recipe").toBe(403);
  });

  it("blocks Alice from DELETEing Bob's recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status, "Alice was able to delete Bob's recipe").toBe(403);
  });

  // ---- Surgical recipe.data ops ----

  it("blocks Alice from PATCH /recipes/:id/data on Bob's recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/data`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { fields: { name: "renamed" } },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from POST /recipes/:id/ingredients on Bob's recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/ingredients`, {
      method: "POST",
      token: alice.apiToken,
      body: { ingredient: "salt" },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from PATCH /recipes/:id/ingredients/:index on Bob's recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/ingredients/0`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { ingredient: "poison" },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from DELETE /recipes/:id/ingredients/:index on Bob's recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/ingredients/0`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from POST /recipes/:id/ingredients/reorder on Bob's recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/ingredients/reorder`, {
      method: "POST",
      token: alice.apiToken,
      body: { order: [0] },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from POST /recipes/:id/steps on Bob's recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/steps`, {
      method: "POST",
      token: alice.apiToken,
      body: { text: "phantom step" },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from PATCH /recipes/:id/steps/:index on Bob's recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/steps/0`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { text: "hijacked step" },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from DELETE /recipes/:id/steps/:index on Bob's recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/steps/0`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from POST /recipes/:id/steps/reorder on Bob's recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/steps/reorder`, {
      method: "POST",
      token: alice.apiToken,
      body: { order: [0] },
    });
    expect(status).toBe(403);
  });

  // ---- Cooking log ----

  it("blocks Alice from POST /recipes/:id/cooking-log on Bob's recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/cooking-log`, {
      method: "POST",
      token: alice.apiToken,
      body: { notes: "alice cooked it (lie)" },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from GET /recipes/:id/cooking-log on Bob's private recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/cooking-log`, {
      token: alice.apiToken,
    });
    expect([403, 404]).toContain(status);
  });

  it("blocks Alice from PATCH /cooking-log/:eventId on Bob's event", async () => {
    const { status } = await apiReq(`/data/cooking-log/${bobsCookingLogId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { notes: "tampered" },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from DELETE /cooking-log/:eventId on Bob's event", async () => {
    const { status } = await apiReq(`/data/cooking-log/${bobsCookingLogId}`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status).toBe(403);
  });

  // ---- Bob's legitimate operations still work ----

  it("still lets Bob PATCH his own recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPublicRecipeId}`, {
      method: "PATCH",
      token: bob.apiToken,
      body: { data: { name: "Bob's renamed public recipe" } },
    });
    expect(status).toBeLessThan(400);
  });

  it("still lets Bob PATCH his own box", async () => {
    const { status } = await apiReq(`/data/boxes/${bobsBoxId}`, {
      method: "PATCH",
      token: bob.apiToken,
      body: { description: "now with a description" },
    });
    expect(status).toBeLessThan(400);
  });

  it("still lets Bob add an ingredient to his own recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/ingredients`, {
      method: "POST",
      token: bob.apiToken,
      body: { ingredient: "sugar" },
    });
    expect(status).toBeLessThan(400);
  });

  it("still lets Bob add a cooking-log entry on his own recipe", async () => {
    const { status } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/cooking-log`, {
      method: "POST",
      token: bob.apiToken,
      body: { notes: "second cook" },
    });
    expect(status).toBeLessThan(400);
  });

  it("still lets Bob list his cooking-log", async () => {
    const { status, data } = await apiReq(`/data/recipes/${bobsPrivateRecipeId}/cooking-log`, {
      token: bob.apiToken,
    });
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });

  // ---- DELETE attacks against fresh throw-away records (cascades would
  //      otherwise nuke earlier-test fixtures and turn 200s into 404s). ----

  it("blocks Alice from DELETEing Bob's box (fresh fixture)", async () => {
    // Create a fresh box owned by Bob and verify Alice can't delete it.
    // Pre-fix this succeeded (admin PB bypass) and cascaded recipes/events.
    const bobPb = new PocketBase(PB_URL);
    bobPb.autoCancellation(false);
    bobPb.authStore.save(bob.userJwt, null);
    const freshBox = await bobPb.collection("recipe_boxes").create({
      name: "Bob's throwaway box",
      visibility: "private",
      owners: [bob.id],
    });
    const { status } = await apiReq(`/data/boxes/${freshBox.id}`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status, "Alice was able to delete Bob's box").toBe(403);
    // And the box should still exist.
    const stillThere = await adminPb.collection("recipe_boxes").getOne(freshBox.id).catch(() => null);
    expect(stillThere, "Bob's box was deleted despite the 403").not.toBeNull();
  });
});
