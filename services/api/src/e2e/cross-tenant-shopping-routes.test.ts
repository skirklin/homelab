/**
 * Regression test for cross-tenant reads/writes via `/data/shopping/*` routes.
 *
 * Same admin-PB-bypass shape as cross-tenant-data-routes.test.ts (travel) and
 * cross-tenant-recipes-routes.test.ts. `hlk_`/`mcpat_` tokens authenticate
 * against a superuser PocketBase client that ignores PB collection rules
 * entirely — so migration 0024's tightened rules don't help here.
 * Route-level ownership checks are the only thing standing between an
 * attacker's token and another user's shopping lists.
 *
 * Smoking guns the original audit flagged:
 *   - Alice POSTs an item into Bob's list → pre-fix 201
 *   - Alice PATCHes Bob's item (changes ingredient) → pre-fix 200
 *   - Alice DELETEs Bob's list → pre-fix 200 (cascades nuke Bob's items)
 *   - Alice PATCH-reparents Bob's item via `list` field → pre-fix 200
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
let bobsListId: string;
let bobsItemId: string;
let bobsCheckedItemId: string;
let alicesListId: string;

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

  // Bob owns a shopping list with one unchecked + one checked item.
  // Both are seeded through admin PB so PB's own rules don't get in our way
  // during setup.
  const bobsList = await adminPb.collection("shopping_lists").create({
    name: "Bob's groceries",
    owners: [bob.id],
  });
  bobsListId = bobsList.id;

  const bobsItem = await adminPb.collection("shopping_items").create({
    list: bobsListId,
    ingredient: "Bob's milk",
    note: "",
    category_id: "dairy",
    checked: false,
    added_by: bob.id,
  });
  bobsItemId = bobsItem.id;

  const bobsChecked = await adminPb.collection("shopping_items").create({
    list: bobsListId,
    ingredient: "Bob's eggs",
    note: "",
    category_id: "dairy",
    checked: true,
    added_by: bob.id,
  });
  bobsCheckedItemId = bobsChecked.id;

  // Wire Bob's slug map so GET /data/shopping/lists actually surfaces the
  // list for Bob's legitimate-control tests.
  await adminPb.collection("users").update(bob.id, {
    shopping_slugs: { groceries: bobsListId },
  });

  // Alice's own list — used both to verify her legitimate ops still work
  // and to power the reparent attack (move Bob's item into Alice's list).
  const alicesList = await adminPb.collection("shopping_lists").create({
    name: "Alice's groceries",
    owners: [alice.id],
  });
  alicesListId = alicesList.id;
  await adminPb.collection("users").update(alice.id, {
    shopping_slugs: { groceries: alicesListId },
  });
});

describe("cross-tenant access via /data/shopping/* (admin-PB bypass)", () => {
  // ---- Reads ----

  it("blocks Alice's hlk_ token from listing items in Bob's list", async () => {
    // Pre-fix GET /data/shopping/items?list=<bob's list> had no ownership
    // gate; any token holder could enumerate any list's items by ID.
    const { status, data } = await apiReq(`/data/shopping/items?list=${bobsListId}`, {
      token: alice.apiToken,
    });
    if (status === 200) {
      // The smoking gun: confirm Bob's items leaked.
      const ids = (data as Array<{ id: string }>).map((i) => i.id);
      expect(
        ids,
        `Alice was able to enumerate Bob's items: ${JSON.stringify(data)}`,
      ).not.toContain(bobsItemId);
    } else {
      expect([403, 404]).toContain(status);
    }
  });

  it("still lets Bob list items in his own list", async () => {
    const { status, data } = await apiReq(`/data/shopping/items?list=${bobsListId}`, {
      token: bob.apiToken,
    });
    expect(status).toBe(200);
    const ids = (data as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(bobsItemId);
  });

  // ---- Item writes ----

  it("blocks Alice from POST-ing a new item into Bob's list", async () => {
    // Smoking gun #1 from the audit.
    const { status, data } = await apiReq("/data/shopping/items", {
      method: "POST",
      token: alice.apiToken,
      body: {
        list: bobsListId,
        ingredient: "alice-planted-item",
        category_id: "uncategorized",
      },
    });
    expect(
      status,
      `Alice was able to plant an item in Bob's list; body: ${JSON.stringify(data)}`,
    ).toBe(403);
    // Defense-in-depth: confirm nothing landed under Bob's list with that ingredient.
    const probe = await adminPb.collection("shopping_items").getFullList({
      filter: adminPb.filter("list = {:list} && ingredient = {:i}", {
        list: bobsListId,
        i: "alice-planted-item",
      }),
    });
    expect(probe.length, "Alice's item was created despite a non-201 response").toBe(0);
  });

  it("blocks Alice from PATCHing Bob's item", async () => {
    // Smoking gun #2.
    const { status } = await apiReq(`/data/shopping/items/${bobsItemId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { ingredient: "hijacked ingredient" },
    });
    expect(status, "Alice was able to mutate Bob's item").toBe(403);
    // And the ingredient is unchanged.
    const fresh = await adminPb.collection("shopping_items").getOne(bobsItemId);
    expect(fresh.ingredient).toBe("Bob's milk");
  });

  it("blocks Alice from toggling `checked` on Bob's item", async () => {
    const { status } = await apiReq(`/data/shopping/items/${bobsItemId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { checked: true },
    });
    expect(status, "Alice was able to check Bob's item").toBe(403);
    const fresh = await adminPb.collection("shopping_items").getOne(bobsItemId);
    expect(fresh.checked).toBe(false);
  });

  it("blocks Alice from PATCH-reparenting Bob's item into her list", async () => {
    // Smoking gun #4: even if the per-item ownership gate fires, an attacker
    // could otherwise sneak `list: <alice's list>` through and effectively
    // steal the item. The route should either 403 or strip the `list` field.
    const { status } = await apiReq(`/data/shopping/items/${bobsItemId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { list: alicesListId, ingredient: "stolen" },
    });
    const fresh = await adminPb.collection("shopping_items").getOne(bobsItemId);
    if (status < 400) {
      // If the route allowed the call at all (e.g. silently stripping the
      // list field), the item MUST still be in Bob's list and unchanged.
      expect(
        fresh.list,
        "Alice reparented Bob's item under a non-error response",
      ).toBe(bobsListId);
      expect(fresh.ingredient).toBe("Bob's milk");
    } else {
      expect(status).toBe(403);
      expect(fresh.list).toBe(bobsListId);
      expect(fresh.ingredient).toBe("Bob's milk");
    }
  });

  it("blocks Alice from DELETEing Bob's item", async () => {
    const { status } = await apiReq(`/data/shopping/items/${bobsItemId}`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status, "Alice was able to delete Bob's item").toBe(403);
    const stillThere = await adminPb.collection("shopping_items").getOne(bobsItemId).catch(() => null);
    expect(stillThere, "Bob's item was deleted despite the 403").not.toBeNull();
  });

  it("blocks Alice from POST /data/shopping/clear-checked on Bob's list", async () => {
    // Pre-fix this nuked every checked item in Bob's list.
    const { status } = await apiReq("/data/shopping/clear-checked", {
      method: "POST",
      token: alice.apiToken,
      body: { list: bobsListId },
    });
    expect(status, "Alice was able to clear Bob's checked items").toBe(403);
    const stillThere = await adminPb.collection("shopping_items").getOne(bobsCheckedItemId).catch(() => null);
    expect(stillThere, "Bob's checked item was deleted despite the 403").not.toBeNull();
  });

  // ---- List writes ----

  it("blocks Alice from PATCHing Bob's list", async () => {
    const { status } = await apiReq(`/data/shopping/lists/${bobsListId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { name: "hijacked list" },
    });
    expect(status, "Alice was able to rename Bob's list").toBe(403);
    const fresh = await adminPb.collection("shopping_lists").getOne(bobsListId);
    expect(fresh.name).toBe("Bob's groceries");
  });

  it("blocks Alice from DELETEing Bob's list (fresh fixture)", async () => {
    // Create a fresh list owned by Bob and verify Alice can't nuke it.
    // Pre-fix this succeeded and cascade-deleted every item in the list.
    const freshList = await adminPb.collection("shopping_lists").create({
      name: "Bob's throwaway list",
      owners: [bob.id],
    });
    const { status } = await apiReq(`/data/shopping/lists/${freshList.id}`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status, "Alice was able to delete Bob's list").toBe(403);
    const stillThere = await adminPb.collection("shopping_lists").getOne(freshList.id).catch(() => null);
    expect(stillThere, "Bob's list was deleted despite the 403").not.toBeNull();
  });

  // ---- Bob's legitimate operations still work ----

  it("still lets Bob create a new list", async () => {
    const { status, data } = await apiReq("/data/shopping/lists", {
      method: "POST",
      token: bob.apiToken,
      body: { name: "Bob's snacks", slug: "snacks" },
    });
    expect(status).toBe(201);
    const id = (data as { id: string }).id;
    expect(id).toBeTruthy();
  });

  it("still lets Bob add an item to his own list", async () => {
    const { status } = await apiReq("/data/shopping/items", {
      method: "POST",
      token: bob.apiToken,
      body: { list: bobsListId, ingredient: "butter", category_id: "dairy" },
    });
    expect(status).toBe(201);
  });

  it("still lets Bob PATCH his own item", async () => {
    const { status } = await apiReq(`/data/shopping/items/${bobsItemId}`, {
      method: "PATCH",
      token: bob.apiToken,
      body: { note: "skim" },
    });
    expect(status).toBe(200);
    const fresh = await adminPb.collection("shopping_items").getOne(bobsItemId);
    expect(fresh.note).toBe("skim");
  });

  it("still lets Bob clear his checked items", async () => {
    // Plant a checked item Bob owns + verify the clear hits exactly it.
    const planted = await adminPb.collection("shopping_items").create({
      list: bobsListId,
      ingredient: "Bob's about-to-be-cleared item",
      checked: true,
      added_by: bob.id,
    });
    const { status } = await apiReq("/data/shopping/clear-checked", {
      method: "POST",
      token: bob.apiToken,
      body: { list: bobsListId },
    });
    expect(status).toBe(200);
    const gone = await adminPb.collection("shopping_items").getOne(planted.id).catch(() => null);
    expect(gone).toBeNull();
  });

  it("still lets Bob PATCH his own list", async () => {
    const { status } = await apiReq(`/data/shopping/lists/${bobsListId}`, {
      method: "PATCH",
      token: bob.apiToken,
      body: { name: "Bob's groceries (renamed)" },
    });
    expect(status).toBe(200);
    // Reset the name so later expectations on "Bob's groceries" still hold
    // if tests are re-ordered.
    await adminPb.collection("shopping_lists").update(bobsListId, {
      name: "Bob's groceries",
    });
  });
});
