/**
 * Regression test for the silent-strip behavior of the `roles` field on the
 * `api_tokens` collection.
 *
 * Background — auth-policy §8.1 exploit, pre-fix:
 *
 *   PB migration 0024 set `api_tokens.createRule = 'user = @request.auth.id'`,
 *   which gates row insertion but not individual fields. The `roles` JSON
 *   field added in 0025 has no per-field restriction. So any authenticated
 *   user could POST directly to PB at
 *
 *     POST https://api.kirkl.in/api/collections/api_tokens/records
 *     { user: <self>, token_hash, token_prefix, roles: ["infra"] }
 *
 *   and the row would be created with `roles: ["infra"]`. The API auth
 *   middleware (services/api/src/middleware/auth.ts:152-171) then trusts the
 *   `roles` field at validation time and stamps `tokenRoles = ["infra"]` on
 *   the context — granting infra-write access to /data/deployments and
 *   /data/pod_events. A normal user could self-elevate to forge deployment
 *   history or retention-delete real pod events.
 *
 * Fix — silent strip in a PB JS hook (infra/pocketbase/pb_hooks/api_tokens.pb.js):
 *
 *   On create and update of `api_tokens`, if the request's auth is NOT a
 *   superuser, blank `roles` to `[]` before persistence. Silent — not a
 *   throw — so an attacker can't enumerate that `roles` is a privileged
 *   field. The legit Settings UI path is unaffected (it never sets `roles`).
 *   The operator path (PB admin UI, used to stamp HOMELAB_API_TOKEN with
 *   `roles: ["infra"]`) authenticates as superuser and passes through
 *   untouched.
 *
 * This test pins:
 *   1. User-context CREATE with `roles: ["infra"]` — row created, roles NOT ["infra"].
 *   2. User-context UPDATE setting `roles: ["infra"]` — roles NOT ["infra"]
 *      (today blocked by updateRule=null, but the hook is belt-and-suspenders
 *      if that rule is ever relaxed).
 *   3. Superuser-context CREATE with `roles: ["infra"]` — roles preserved.
 *   4. Consequence: a user-minted token with the silent-strip cannot POST
 *      /data/deployments (403 because tokenRoles is empty).
 *
 * Requires `pnpm test:env:up`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { createHash, randomBytes } from "crypto";
import { getPbTestUrl } from "./pb-test-url";

const PB_URL = getPbTestUrl();
process.env.PB_URL = PB_URL;
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const { default: { app } } = await import("../test-app");

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** PB's JSON field returns undefined / null / [] depending on serialization
 * quirks. All three mean "no roles". Anything containing "infra" is the
 * elevation we're defending against. */
function isElevated(roles: unknown): boolean {
  return Array.isArray(roles) && roles.includes("infra");
}

let adminPb: PocketBase;
let alice: { id: string; email: string; pb: PocketBase };

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );

  const email = `alice-roles-${Date.now()}-${randomBytes(3).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: "Alice Roles",
  });

  const userPb = new PocketBase(PB_URL);
  userPb.autoCancellation(false);
  await userPb.collection("users").authWithPassword(email, password);

  alice = { id: user.id, email, pb: userPb };
});

async function apiReq(
  path: string,
  opts: { method?: string; token: string; body?: unknown },
): Promise<{ status: number; data: unknown }> {
  const resp = await app.request(path, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: resp.status, data: await resp.json().catch(() => null) };
}

describe("api_tokens.roles silent-strip on user-context writes", () => {
  it("CREATE: user-context POST with roles: ['infra'] persists row but blanks roles", async () => {
    // Alice POSTs directly to PB as herself — the path that bypasses our
    // /auth/tokens route entirely. createRule from 0024 says `user =
    // @request.auth.id`, so the row is allowed. Without the strip hook,
    // `roles: ["infra"]` would also survive.
    const raw = "hlk_" + randomBytes(32).toString("base64url");
    const created = await alice.pb.collection("api_tokens").create({
      user: alice.id,
      name: "alice-exploit-attempt",
      token_hash: hashToken(raw),
      token_prefix: raw.slice(0, 12) + "...",
      roles: ["infra"],
    });

    expect(
      created.id,
      "row creation should not be rejected — that would leak that `roles` is privileged",
    ).toBeTruthy();

    // Verify via admin client so we see what was actually written (not what
    // the user-scoped view returns; rules might filter the response).
    const fromAdmin = await adminPb.collection("api_tokens").getOne(created.id);
    expect(
      isElevated(fromAdmin.roles),
      "silent-strip should have removed 'infra' from roles on a user-context create — pre-fix this is the exploit",
    ).toBe(false);
  });

  it("UPDATE: user-context PATCH setting roles: ['infra'] does not result in an elevated row", async () => {
    // Today `api_tokens.updateRule = null` (immutable from PB-direct), so
    // this path is blocked at the rule layer with 403. The hook is still
    // wired for update as belt-and-suspenders — if the rule is ever
    // relaxed (e.g. to allow renaming a token), the hook keeps `roles`
    // from being elevated.
    const raw = "hlk_" + randomBytes(32).toString("base64url");
    const created = await alice.pb.collection("api_tokens").create({
      user: alice.id,
      name: "alice-normal-then-elevate",
      token_hash: hashToken(raw),
      token_prefix: raw.slice(0, 12) + "...",
    });

    // Sanity: the freshly-created normal token has no roles.
    {
      const fresh = await adminPb.collection("api_tokens").getOne(created.id);
      expect(isElevated(fresh.roles)).toBe(false);
    }

    // Try the update. PB rule blocks it today; assertion is on the end
    // state, not the request outcome.
    try {
      await alice.pb.collection("api_tokens").update(created.id, {
        roles: ["infra"],
      });
    } catch {
      // Expected today: 403 from updateRule=null. Pass through.
    }

    const after = await adminPb.collection("api_tokens").getOne(created.id);
    expect(
      isElevated(after.roles),
      "user-context update must never result in elevated roles — by rule today, by hook tomorrow",
    ).toBe(false);
  });

  it("superuser-context CREATE with roles: ['infra'] preserves roles", async () => {
    // Operator path — PB admin UI / admin PB client. The hook must NOT touch
    // these; this is how the HOMELAB_API_TOKEN record gets stamped with
    // `roles: ["infra"]` post-migration-0025.
    const raw = "hlk_" + randomBytes(32).toString("base64url");
    const created = await adminPb.collection("api_tokens").create({
      user: alice.id,
      name: "infra-token-via-operator",
      token_hash: hashToken(raw),
      token_prefix: raw.slice(0, 12) + "...",
      roles: ["infra"],
    });

    const fromAdmin = await adminPb.collection("api_tokens").getOne(created.id);
    expect(
      isElevated(fromAdmin.roles),
      "superuser-context writes must pass through untouched — this is the operator path",
    ).toBe(true);
  });

  it("consequence: a user-minted 'infra' token cannot POST /data/deployments", async () => {
    // The end-to-end smoking gun. Alice POSTs a token with `roles: ["infra"]`
    // via the exploit path (PB-direct, not /auth/tokens). With the strip
    // hook the roles array is blanked, so when she then presents the raw
    // token to the API service, the auth middleware loads `roles: []`,
    // requireRole(c, "infra") returns 403, and /data/deployments writes are
    // rejected. Pre-fix: this would return 201 and plant a fake deploy row.
    const raw = "hlk_" + randomBytes(32).toString("base64url");
    await alice.pb.collection("api_tokens").create({
      user: alice.id,
      name: "alice-tries-to-deploy",
      token_hash: hashToken(raw),
      token_prefix: raw.slice(0, 12) + "...",
      roles: ["infra"],
    });

    const { status } = await apiReq("/data/deployments", {
      method: "POST",
      token: raw,
      body: {
        git_sha: "alice-forged-sha",
        git_subject: "alice should not be able to plant this",
        status: "success",
        deployer: "alice@evil.example",
      },
    });

    expect(
      status,
      "consequence check: stripped roles must result in 403 on infra-gated routes (pre-fix this was 201)",
    ).toBe(403);
  });
});
