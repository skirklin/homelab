/**
 * Regression test for auth-policy.md §8.12 — the invite-create hook's
 * `auth.collection().name === "users"` discriminator.
 *
 * `infra/pocketbase/pb_hooks/sharing.pb.js` runs `onRecordCreateRequest`
 * against `sharing_invites`. Pre-fix the hook used `authRecord.collectionName`
 * (undefined in PB 0.25's goja runtime), so the user-token branch was never
 * taken and the hook always trusted the client-submitted `created_by`.
 *
 * Behavior the hook MUST enforce:
 *
 *   1. User-token PB-direct create  → hook overrides `created_by`
 *      with `auth.id`, ignoring whatever the client sent.
 *
 *   2. Superuser-context create (e.g. the API service's admin PB
 *      client acting on behalf of a verified user) → hook trusts
 *      `record.created_by` as set by the server.
 *
 * Both pre-fix bugs (the `[0]` push corruption AND the broken
 * discriminator) live in this hook, but only the discriminator is
 * exercised by this test. The push bug is covered by the recipes-app
 * e2e "redeem invite adds user to box owners".
 *
 * Requires `pnpm test:env:up`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";

process.env.PB_URL = process.env.PB_URL ?? "http://127.0.0.1:8091";
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const PB_URL = process.env.PB_URL ?? "http://127.0.0.1:8091";

interface Actor {
  id: string;
  email: string;
  pb: PocketBase;
}

let adminPb: PocketBase;
let alice: Actor;
let bob: Actor;
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
  return { id: user.id, email, pb: userPb };
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );

  alice = await makeActor("alice-share");
  bob = await makeActor("bob-share");

  // Alice owns a private box. She is allowed to create invites for it.
  const alicesBox = await alice.pb.collection("recipe_boxes").create({
    name: `Alice's box ${randomBytes(3).toString("hex")}`,
    owners: [alice.id],
    visibility: "private",
  });
  alicesBoxId = alicesBox.id;
});

describe("sharing_invites: created_by hook (auth-policy §8.12)", () => {
  it("user-token create: hook overrides client-supplied created_by with auth.id", async () => {
    // Alice (user-token) creates an invite for HER box but lies in the
    // payload, claiming created_by=bob.id. The hook must stamp it as
    // alice.id because that's the actual authenticated principal.
    const code = `usertok-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const invite = await alice.pb.collection("sharing_invites").create({
      code,
      target_type: "box",
      target_id: alicesBoxId,
      created_by: bob.id, // ← forged
      redeemed: false,
    });

    expect(invite.created_by).toBe(alice.id);
    expect(invite.created_by).not.toBe(bob.id);

    await adminPb.collection("sharing_invites").delete(invite.id);
  });

  it("superuser create: hook trusts server-set created_by", async () => {
    // Server-context (admin PB) creates an invite on behalf of Alice. The
    // hook should NOT overwrite created_by — admin context is the
    // API-service path, where the server has already verified the actor.
    const code = `super-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const invite = await adminPb.collection("sharing_invites").create({
      code,
      target_type: "box",
      target_id: alicesBoxId,
      created_by: alice.id,
      redeemed: false,
    });

    expect(invite.created_by).toBe(alice.id);

    await adminPb.collection("sharing_invites").delete(invite.id);
  });

  it("user-token create: non-owner is blocked even if they forge created_by to a real owner", async () => {
    // Bob (user-token) tries to create an invite for Alice's box, lying
    // in the payload that created_by=alice.id. The hook must still reject
    // because the *actor* (resolved from auth.id) is Bob, who isn't an owner.
    const code = `nonowner-${Date.now()}-${randomBytes(3).toString("hex")}`;
    await expect(
      bob.pb.collection("sharing_invites").create({
        code,
        target_type: "box",
        target_id: alicesBoxId,
        created_by: alice.id, // ← forged to a real owner
        redeemed: false,
      }),
    ).rejects.toThrow();
  });
});
