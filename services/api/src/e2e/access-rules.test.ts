/**
 * Regression tests for PB access-rule tightening (migration 0024).
 *
 * Three attack paths that should now be blocked:
 *
 *   (1) api_tokens cross-user create — user A authenticates with their PB
 *       JWT, then POSTs to /api/collections/api_tokens/records with
 *       {user: <victim>, token_hash: <attacker-known>} to forge a token
 *       that grants them victim-as-actor access via the auth middleware.
 *
 *   (2) Child-collection cross-tenant create — user A POSTs a row into
 *       user B's shopping_list / task_list / recipe_box / etc. The list
 *       rule hides it from user A afterward, but B sees garbage from a
 *       phantom "co-owner."
 *
 *   (3) Private-recipe-in-public-box leak — user B creates a public box
 *       containing a private recipe. User A authenticates and GETs that
 *       recipe by ID. The old visRule had `box.visibility = "public"`
 *       and `box.visibility != "private"` clauses that ignored per-recipe
 *       visibility, leaking the private recipe.
 *
 * Requires: PocketBase running on localhost:8091 with migration 0024
 * applied. `pnpm test:env:up` (or `docker compose -f docker-compose.test.yml
 * up -d --build` to force a rebuild after editing migrations).
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { createHash, randomBytes } from "crypto";

const PB_URL = process.env.PB_URL ?? "http://127.0.0.1:8091";

/** Assert that a PB SDK call rejects with a 4xx status. PocketBase throws
 *  errors carrying `.status` (number) and a generic message like
 *  "Failed to create record." — matching on the message is brittle. */
async function expectRejectedWith4xx(p: Promise<unknown>): Promise<void> {
  await p.then(
    () => {
      throw new Error("expected rejection, got success");
    },
    (err: { status?: number }) => {
      expect(err.status, `error: ${JSON.stringify(err)}`).toBeGreaterThanOrEqual(400);
      expect(err.status).toBeLessThan(500);
    },
  );
}

let adminPb: PocketBase;
let aliceId: string;
let alicePb: PocketBase;
let bobId: string;
let bobPb: PocketBase;

async function makeUser(suffix: string): Promise<{ id: string; pb: PocketBase }> {
  const email = `test-${suffix}-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: `Test ${suffix}`,
  });
  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  await pb.collection("users").authWithPassword(email, password);
  return { id: user.id, pb };
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );

  ({ id: aliceId, pb: alicePb } = await makeUser("alice"));
  ({ id: bobId, pb: bobPb } = await makeUser("bob"));
});

describe("api_tokens createRule (migration 0024)", () => {
  it("blocks Alice from minting an api_token with user=Bob (account takeover)", async () => {
    const rawToken = "hlk_" + randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    await expectRejectedWith4xx(
      alicePb.collection("api_tokens").create({
        user: bobId,
        name: "forged",
        token_hash: tokenHash,
        token_prefix: rawToken.slice(0, 12) + "...",
      }),
    );
  });

  it("still allows Alice to mint an api_token for herself", async () => {
    const rawToken = "hlk_" + randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const rec = await alicePb.collection("api_tokens").create({
      user: aliceId,
      name: "legit",
      token_hash: tokenHash,
      token_prefix: rawToken.slice(0, 12) + "...",
    });
    expect(rec.user).toBe(aliceId);
  });
});

describe("child-collection createRule (migration 0024)", () => {
  let bobsListId: string;

  beforeAll(async () => {
    const list = await bobPb.collection("shopping_lists").create({
      name: "Bob's list",
      owners: [bobId],
    });
    bobsListId = list.id;
  });

  it("blocks Alice from creating a shopping_item in Bob's list", async () => {
    await expectRejectedWith4xx(
      alicePb.collection("shopping_items").create({
        list: bobsListId,
        ingredient: "phantom milk",
      }),
    );
  });

  it("still allows Bob (the owner) to create items in his own list", async () => {
    const item = await bobPb.collection("shopping_items").create({
      list: bobsListId,
      ingredient: "real milk",
    });
    expect(item.list).toBe(bobsListId);
  });

  it("blocks Alice from creating a task in Bob's task_list", async () => {
    const taskList = await bobPb.collection("task_lists").create({
      name: "Bob's chores",
      owners: [bobId],
    });
    await expectRejectedWith4xx(
      alicePb.collection("tasks").create({
        list: taskList.id,
        name: "phantom chore",
      }),
    );
  });

  it("blocks Alice from creating a recipe in Bob's recipe_box", async () => {
    const box = await bobPb.collection("recipe_boxes").create({
      name: "Bob's box",
      owners: [bobId],
      visibility: "public",
    });
    await expectRejectedWith4xx(
      alicePb.collection("recipes").create({
        box: box.id,
        data: { name: "phantom recipe" },
        owners: [aliceId],
        visibility: "public",
      }),
    );
  });
});

describe("recipe visibility leak (migration 0024)", () => {
  let bobsPublicBoxId: string;
  let bobsPrivateRecipeId: string;
  let bobsPublicRecipeId: string;

  beforeAll(async () => {
    const box = await bobPb.collection("recipe_boxes").create({
      name: "Bob's public box",
      owners: [bobId],
      visibility: "public",
    });
    bobsPublicBoxId = box.id;

    const priv = await bobPb.collection("recipes").create({
      box: box.id,
      data: { name: "Bob's secret recipe" },
      owners: [bobId],
      visibility: "private",
    });
    bobsPrivateRecipeId = priv.id;

    const pub = await bobPb.collection("recipes").create({
      box: box.id,
      data: { name: "Bob's public recipe" },
      owners: [bobId],
      visibility: "public",
    });
    bobsPublicRecipeId = pub.id;
  });

  it("hides Bob's PRIVATE recipe in his public box from Alice (leak closed)", async () => {
    // Pre-migration this returned the recipe via the `box.visibility = "public"`
    // clause that ignored per-recipe visibility. Post-migration it 404s.
    await expectRejectedWith4xx(
      alicePb.collection("recipes").getOne(bobsPrivateRecipeId),
    );
  });

  it("still surfaces Bob's PUBLIC recipe in his public box to Alice", async () => {
    const rec = await alicePb.collection("recipes").getOne(bobsPublicRecipeId);
    expect(rec.id).toBe(bobsPublicRecipeId);
  });

  it("box itself is still visible to Alice (public box behavior preserved)", async () => {
    const box = await alicePb.collection("recipe_boxes").getOne(bobsPublicBoxId);
    expect(box.id).toBe(bobsPublicBoxId);
  });
});
