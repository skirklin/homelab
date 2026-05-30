/**
 * PocketBase test utilities for e2e tests.
 *
 * Usage:
 *   const ctx = await initTestPocketBase();
 *   const user = await createTestUser(ctx);
 *   // ... run tests using ctx.pb (admin-authed client) ...
 *   await cleanupTestPocketBase(ctx);
 *
 * Requires a PocketBase instance running at PB_TEST_URL (default: http://127.0.0.1:8091).
 * Start the full test env (PocketBase + API) with: pnpm test:env:up
 */

import PocketBase, { LocalAuthStore } from "pocketbase";
import { initializeBackend } from "./backend";

/**
 * Cold-start fallback PB URL — the main checkout's legacy test PB port.
 *
 * The single source of truth for the `:8091` literal on the TS side: this
 * module's own `PB_TEST_URL` below AND every app's `vitest.e2e.config.ts`
 * (via `e2eTestConfig()`) read it from here, so the port lives in exactly
 * one place per dependency layer. (`@kirkl/vite-preset` keeps its own copy —
 * it's a lower-level package that can't import this `.ts` without breaking
 * its `tsc` typecheck, and this package can't import the preset's `.mjs`
 * for the same reason; the two are kept in sync by hand, both documented.)
 */
export const PB_TEST_URL_FALLBACK = "http://127.0.0.1:8091";

const PB_TEST_URL = process.env.PB_TEST_URL || PB_TEST_URL_FALLBACK;
const ADMIN_EMAIL = "test-admin@test.local";
const ADMIN_PASSWORD = "testpassword1234";

/**
 * Create a superuser-authed PocketBase client, idempotently. Signs in as the
 * canonical test admin; if no superuser exists yet (a fresh test PB), creates
 * it first. Throws with a clear message if neither works — almost always
 * "the test env isn't running."
 *
 * This is THE admin-auth-or-create primitive. `initTestPocketBase` (the
 * vitest TestContext factory), `setupTestEnv` (the Playwright globalSetup
 * helper), and the recipes Playwright fixtures all route through it instead
 * of each re-spelling the try/auth-catch/create dance.
 *
 * @param url Defaults to the resolved per-worktree `PB_TEST_URL`.
 * @param authStore Optional auth store. `initTestPocketBase` passes a NAMED
 *   `LocalAuthStore` to keep the admin client's auth isolated from the test
 *   user / shared `getBackend()` singleton — without it, `signInAsUser`
 *   clobbers the admin token via a shared default store and subsequent
 *   admin-scoped operations (e.g. sharing-invite cleanup) 404. (See the
 *   2026-04-18 "signInAsUser overwrites ctx.pb admin auth" incident.) Most
 *   callers only ever have one client and can omit it.
 */
export async function newAdminPb(
  url: string = PB_TEST_URL,
  authStore?: ConstructorParameters<typeof PocketBase>[1]
): Promise<PocketBase> {
  const pb = new PocketBase(url, authStore);
  pb.autoCancellation(false);
  try {
    await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  } catch {
    try {
      await pb.collection("_superusers").create({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        passwordConfirm: ADMIN_PASSWORD,
      });
      await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
    } catch (e) {
      throw new Error(
        `Failed to initialize PocketBase test admin at ${url}. ` +
          `Is the test environment running? (pnpm test:env:up)\n${e}`
      );
    }
  }
  return pb;
}

export interface TestContext {
  /** Admin-authenticated PocketBase client — bypasses API rules */
  pb: PocketBase;
  /** The currently "active" test user (set by createTestUser / signInAsUser) */
  testUser: TestUser | null;
  /** A second PB client authenticated as the test user (respects API rules) */
  userPb: PocketBase;
}

export interface TestUser {
  id: string;
  uid: string; // alias for id
  email: string;
  localId: string; // alias for id (Firebase compat)
}

/**
 * Initialize a PocketBase test context.
 * Creates the first superuser if none exists, then authenticates as admin.
 */
export async function initTestPocketBase(): Promise<TestContext> {
  // Admin client — auth-or-create via the shared primitive. The NAMED
  // `pb_test_admin` LocalAuthStore is load-bearing, not decorative: it
  // isolates the admin token from the test user / shared getBackend()
  // singleton. Without it, `signInAsUser` clobbers the admin auth (shared
  // default in-memory store) and later admin-scoped cleanup 404s — exactly
  // the 4 sharing-invite failures this restores. (2026-04-18 incident.)
  const pb = await newAdminPb(PB_TEST_URL, new LocalAuthStore("pb_test_admin"));

  const userPb = new PocketBase(PB_TEST_URL, new LocalAuthStore("pb_test_user"));
  userPb.autoCancellation(false);

  // Initialize the shared backend singleton so app code (getBackend()) works in tests
  initializeBackend(PB_TEST_URL);

  return { pb, testUser: null, userPb };
}

/**
 * Create a test user and sign in as them.
 */
export async function createTestUser(
  ctx: TestContext,
  overrides?: { email?: string; name?: string }
): Promise<TestUser> {
  const email = overrides?.email || `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const password = "testpassword123";

  const record = await ctx.pb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: overrides?.name || "Test User",
  });

  const user: TestUser = {
    id: record.id,
    uid: record.id,
    email,
    localId: record.id,
  };

  // Sign in both the user client and the shared backend singleton
  await ctx.userPb.collection("users").authWithPassword(email, password);
  const { getBackend } = await import("./backend");
  await getBackend().collection("users").authWithPassword(email, password);
  ctx.testUser = user;

  return user;
}

/**
 * Create a test user WITHOUT signing in as them.
 * Useful for multi-user tests.
 */
export async function createUserWithoutSignIn(ctx: TestContext): Promise<TestUser> {
  const email = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const password = "testpassword123";

  const record = await ctx.pb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: "Test User 2",
  });

  return {
    id: record.id,
    uid: record.id,
    email,
    localId: record.id,
  };
}

/**
 * Sign in as a specific test user.
 * Also authenticates the shared backend singleton so app functions work.
 */
export async function signInAsUser(ctx: TestContext, user: TestUser): Promise<void> {
  const password = "testpassword123";
  await ctx.userPb.collection("users").authWithPassword(user.email, password);
  // Also auth the shared singleton so app code (getBackend().authStore) works
  const { getBackend } = await import("./backend");
  await getBackend().collection("users").authWithPassword(user.email, password);
  ctx.testUser = user;
}

/**
 * Tracks created records for cleanup after each test.
 */
export class TestCleanup {
  private records: Array<{ collection: string; id: string }> = [];
  private adminPb: PocketBase | null = null;

  bind(pb: PocketBase) {
    this.adminPb = pb;
  }

  track(collectionName: string, id: string) {
    this.records.push({ collection: collectionName, id });
  }

  async cleanup() {
    if (!this.adminPb) return;
    // Delete in reverse order (children before parents)
    for (const rec of [...this.records].reverse()) {
      try {
        await this.adminPb.collection(rec.collection).delete(rec.id);
      } catch {
        // Already deleted or doesn't exist — fine
      }
    }
    this.records = [];
  }
}

/**
 * Hard-wipe every record in the given collections, using an admin-authed
 * PB client. Used by Playwright globalSetup to give each run a known-clean
 * slate (the test PB is exclusively for tests, so deleting all records is
 * safe). Delete order matters when foreign-key/cascade hooks fire, so pass
 * children before parents (e.g. `shopping_items` before `shopping_lists`).
 *
 * Each collection is drained page-by-page; missing collections and
 * already-gone records are ignored so the wipe is robust to schema drift
 * and partially-cleaned state.
 */
export async function wipeCollections(
  adminPb: PocketBase,
  collections: string[]
): Promise<void> {
  for (const name of collections) {
    try {
      // getFullList walks all pages; batch=500 keeps it to one request for
      // the volumes a test PB ever accumulates.
      const records = await adminPb
        .collection(name)
        .getFullList({ batch: 500, $autoCancel: false });
      for (const rec of records) {
        try {
          await adminPb.collection(name).delete(rec.id, { $autoCancel: false });
        } catch {
          // already gone / cascade-deleted by a hook — fine. (This inner
          // catch is correctly narrow: by the time we're deleting a known
          // record id, the only expected failure is "it's already gone.")
        }
      }
    } catch (e) {
      // ONLY the benign "this collection doesn't exist in this schema" is
      // safe to swallow — that's a 404. Anything else (auth expired, network
      // down, a 500) means the wipe silently didn't happen, leaving dirty
      // state that masks regressions in the next run. Fail loud instead.
      if (isNotFoundError(e)) continue;
      throw e;
    }
  }
}

/**
 * True for the one error wipe-shaped helpers may safely ignore: PB answered
 * 404 — the collection doesn't exist in this schema (for `wipeCollections`)
 * or a record vanished between listing and acting on it (for
 * `clearUserFields`). Everything else — expired admin auth, a connection
 * refused, a 500 — must propagate so a failed wipe can't masquerade as a
 * clean slate.
 *
 * PocketBase throws `ClientResponseError` carrying a numeric `.status`; a
 * raw network failure (no response) surfaces as `.status === 0`, which we
 * deliberately do NOT treat as "missing" — that's a real failure to wipe.
 */
function isNotFoundError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "status" in e &&
    (e as { status?: unknown }).status === 404
  );
}

/**
 * Reset per-user pointer fields (slug maps, the `recipe_boxes` array) to
 * empty for every test user, so a wiped collection doesn't leave dangling
 * references behind. Without this, e.g. `shopping_slugs` keeps a stale
 * `{"weekly-groceries": "<deleted-list-id>"}`, and the next run's
 * "create a list called Weekly Groceries" trips the "you already have a
 * list with that name" slug guard — the exact non-idempotency bug the
 * shopping RUN_ID hack was working around.
 *
 * Scopes to test users (`email ~ "test.local"` OR the app's own
 * `@example.com` / `@test.local` fixtures) by accepting an explicit filter;
 * the caller passes whatever matches its fixture emails. `fields` is the
 * set of JSON columns to clear; objects → `{}`, arrays → `[]` based on the
 * passed shape.
 *
 * Fail-loud: any error from listing or updating users propagates. The
 * `users` collection is the built-in PB auth collection (always exists), so
 * unlike {@link wipeCollections} there is no benign "missing collection"
 * case to swallow. A silently-no-op'd wipe must never be able to masquerade
 * as a clean slate — that's how stale `shopping_slugs` survived into the
 * next Playwright run and tripped the slug-uniqueness guard.
 */
export async function clearUserFields(
  adminPb: PocketBase,
  fields: Record<string, unknown>,
  opts?: { filter?: string }
): Promise<void> {
  const users = await adminPb.collection("users").getFullList({
    batch: 500,
    $autoCancel: false,
    ...(opts?.filter ? { filter: opts.filter } : {}),
  });
  for (const user of users) {
    try {
      await adminPb
        .collection("users")
        .update(user.id, fields, { $autoCancel: false });
    } catch (e) {
      // ONLY benign: the user record was deleted between listing and
      // updating (concurrent wipe / cascade-delete from a hook). That's
      // a 404 on update — anything else (auth expired, network down, a
      // 500) means the field-clear silently didn't happen, leaving stale
      // pointers behind. Same fail-loud principle as the outer call.
      if (isNotFoundError(e)) continue;
      throw e;
    }
  }
}

/**
 * Options for {@link setupTestEnv}.
 *
 * The URL resolution + env-bring-up are passed IN rather than imported here,
 * deliberately: those live in `@kirkl/vite-preset`, and `@kirkl/shared`
 * (this package) must not depend on the preset (it would drag the React/PWA
 * vite plugins into every spec's import graph, and the preset's untyped
 * `.mjs` would break this package's `tsc` typecheck). Each app's
 * `e2e/global-setup.ts` already imports the preset, so it owns that coupling
 * and hands us the resolved values.
 */
export interface SetupTestEnvOptions {
  /** Resolved per-worktree PB URL (from `resolveTestPbUrl()`). */
  pbUrl: string;
  /** Resolved per-worktree API URL (from `resolveDevApiTarget()`). */
  apiUrl: string;
  /**
   * Idempotent env-bring-up (`ensureTestEnvUp` from the preset). Called
   * first; throws + aborts the run if the containers can't come up healthy.
   */
  ensureUp: () => void;
  /**
   * Collections to wipe, children before parents (so cleanup hooks never
   * trip over orphans). Each app passes ONLY its own collections.
   */
  collections: string[];
  /**
   * Per-user pointer fields to reset (slug maps, the `recipe_boxes` array).
   * Objects → `{}`, arrays → `[]`, matching the passed shape. See
   * {@link clearUserFields}.
   */
  userFields: Record<string, unknown>;
  /**
   * Optional users to find-or-create (with a known password) after the wipe
   * — for specs that sign in as fixed accounts rather than minting a fresh
   * user per test. Each entry: `{ email, name }`.
   */
  seedUsers?: Array<{ email: string; name: string }>;
}

/** Password every seeded test user gets (matches the spec fixtures). */
const TEST_USER_PASSWORD = "testpassword123";

/**
 * The one canonical Playwright globalSetup body, shared by every app.
 *
 * Sequence (identical for all apps — only `collections` / `userFields` /
 * `seedUsers` differ):
 *   1. `ensureUp()` — idempotently bring the per-worktree PB + API up.
 *   2. Probe PB health, then API health; throw a clear message if either's down.
 *   3. Admin auth-or-create via {@link newAdminPb}.
 *   4. `wipeCollections(collections)` — start every run from a clean slate.
 *   5. `clearUserFields(userFields)` — drop dangling per-user pointers.
 *   6. (optional) find-or-create the `seedUsers`.
 *
 * Wipe-before, not teardown-after: a crashed run must never poison the next.
 *
 * Returns nothing — Playwright's globalSetup ignores the return value.
 */
export async function setupTestEnv(opts: SetupTestEnvOptions): Promise<void> {
  const { pbUrl, apiUrl, ensureUp, collections, userFields, seedUsers } = opts;

  // 1. Bring the env up (idempotent). Throws + aborts the run if it can't.
  ensureUp();

  console.log(`Verifying test env (PB=${pbUrl}, API=${apiUrl})...`);

  // 2. Probe PB (unauthenticated), then API. Health-check first so a dead env
  //    surfaces as "PB not running" rather than a confusing auth failure.
  const pb = new PocketBase(pbUrl);
  pb.autoCancellation(false);
  try {
    await pb.health.check();
  } catch {
    throw new Error(
      `PocketBase not running at ${pbUrl}. Start the test env with: pnpm test:env:up`
    );
  }
  try {
    const resp = await fetch(`${apiUrl}/health`);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
  } catch (e) {
    throw new Error(
      `API service not running at ${apiUrl}. Start the test env with: pnpm test:env:up\n${e}`
    );
  }

  // 3. Admin auth-or-create. (A PocketBase client is a stateless HTTP wrapper,
  //    not a held connection, so the dedicated admin client here costs
  //    nothing over reusing the health-probe one — and it keeps the
  //    auth-or-create logic in the single newAdminPb primitive. The default
  //    auth store is fine: globalSetup never signs in as a user on this
  //    client, so there's nothing to clobber the admin token.)
  const admin = await newAdminPb(pbUrl);

  // 4 + 5. Wipe this app's own collections + clear the per-user pointer fields
  //         that reference them, so the next run sees a truly clean slate.
  await wipeCollections(admin, collections);
  await clearUserFields(admin, userFields);

  // 6. Seed any fixed accounts the specs sign in as.
  for (const u of seedUsers ?? []) {
    await ensureSeedUser(admin, u.email, u.name);
  }

  console.log("✓ Test environment ready (data wiped).\n");
}

/** Find-or-create a test user and force the known password. */
async function ensureSeedUser(
  adminPb: PocketBase,
  email: string,
  name: string
): Promise<void> {
  try {
    const existing = await adminPb
      .collection("users")
      .getFirstListItem(`email = "${email}"`, { $autoCancel: false });
    await adminPb.collection("users").update(
      existing.id,
      { password: TEST_USER_PASSWORD, passwordConfirm: TEST_USER_PASSWORD },
      { $autoCancel: false }
    );
  } catch {
    await adminPb.collection("users").create(
      {
        email,
        password: TEST_USER_PASSWORD,
        passwordConfirm: TEST_USER_PASSWORD,
        name,
      },
      { $autoCancel: false }
    );
  }
}

/**
 * Clean up the test context. Deletes all test users created during the session.
 */
export async function cleanupTestPocketBase(ctx: TestContext): Promise<void> {
  // Delete all non-admin users created during testing
  try {
    const users = await ctx.pb.collection("users").getFullList({
      filter: 'email ~ "test.local"',
    });
    for (const user of users) {
      try {
        await ctx.pb.collection("users").delete(user.id);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

// ─── Shopping helpers ───────────────────────────────────────

export async function createTestList(
  ctx: TestContext,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    owners?: string[];
    categoryDefs?: Array<{ id: string; name: string; color: string }>;
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("shopping_lists").create({
    name: overrides?.name || "Test List",
    owners: overrides?.owners || [ctx.testUser!.id],
    category_defs: overrides?.categoryDefs || [],
  });
  cleanup.track("shopping_lists", record.id);
  return { id: record.id };
}

export async function createTestItem(
  ctx: TestContext,
  listId: string,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    categoryId?: string;
    checked?: boolean;
    note?: string;
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("shopping_items").create({
    list: listId,
    ingredient: overrides?.name !== undefined ? overrides.name : "Test Item",
    category_id: overrides?.categoryId || "uncategorized",
    checked: overrides?.checked || false,
    checked_by: overrides?.checked ? ctx.testUser!.id : "",
    added_by: ctx.testUser!.id,
    note: overrides?.note || "",
  });
  cleanup.track("shopping_items", record.id);
  return { id: record.id };
}

// ─── Life tracker helpers ───────────────────────────────────

export async function createTestLifeLog(
  ctx: TestContext,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    owner?: string;
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("life_logs").create({
    name: overrides?.name || "Test Life Log",
    owner: overrides?.owner || ctx.testUser!.id,
    manifest: { widgets: [] },
  });
  cleanup.track("life_logs", record.id);
  return { id: record.id };
}

export async function createTestEntry(
  ctx: TestContext,
  logId: string,
  cleanup: TestCleanup,
  overrides?: {
    type?: string;
    startTime?: string;
    endTime?: string | null;
    duration?: number | null;
    notes?: string;
  }
): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const record = await ctx.pb.collection("life_events").create({
    log: logId,
    subject_id: overrides?.type || "sleep",
    timestamp: overrides?.startTime || now,
    created_by: ctx.testUser!.id,
    data: {
      type: overrides?.type || "sleep",
      startTime: overrides?.startTime || now,
      endTime: overrides?.endTime !== undefined ? overrides.endTime : now,
      duration: overrides?.duration !== undefined ? overrides.duration : 30,
      notes: overrides?.notes || "",
    },
  });
  cleanup.track("life_events", record.id);
  return { id: record.id };
}

// ─── Upkeep helpers ─────────────────────────────────────────

export async function createTestTaskList(
  ctx: TestContext,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    owners?: string[];
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("task_lists").create({
    name: overrides?.name || "Test Task List",
    owners: overrides?.owners || [ctx.testUser!.id],
    room_defs: [],
  });
  cleanup.track("task_lists", record.id);
  return { id: record.id };
}

export async function createTestTask(
  ctx: TestContext,
  listId: string,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    roomId?: string;
    intervalDays?: number;
    frequency?: { value: number; unit: string };
    lastCompleted?: string | null;
    notifyUsers?: string[];
  }
): Promise<{ id: string }> {
  const freq = overrides?.frequency || {
    value: overrides?.intervalDays !== undefined ? overrides.intervalDays : 7,
    unit: "days",
  };
  const record = await ctx.pb.collection("tasks").create({
    list: listId,
    name: overrides?.name !== undefined ? overrides.name : "Test Task",
    room_id: overrides?.roomId || "general",
    frequency: freq,
    last_completed: overrides?.lastCompleted || null,
    notify_users: overrides?.notifyUsers || [],
  });
  cleanup.track("tasks", record.id);
  return { id: record.id };
}

// ─── Recipes helpers ────────────────────────────────────────

export async function createTestBox(
  ctx: TestContext,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    owners?: string[];
    visibility?: string;
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("recipe_boxes").create({
    name: overrides?.name || "Test Box",
    owners: overrides?.owners || [ctx.testUser!.id],
    visibility: overrides?.visibility || "private",
  });
  cleanup.track("recipe_boxes", record.id);
  return { id: record.id };
}

export async function createTestRecipe(
  ctx: TestContext,
  boxId: string,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    data?: Record<string, unknown>;
    owners?: string[];
    visibility?: string;
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("recipes").create({
    box: boxId,
    data: {
      name: overrides?.name !== undefined ? overrides.name : "Test Recipe",
      ...overrides?.data,
    },
    owners: overrides?.owners || [ctx.testUser!.id],
    visibility: overrides?.visibility || "private",
    creator: ctx.testUser!.id,
  });
  cleanup.track("recipes", record.id);
  return { id: record.id };
}

export async function addBoxToUser(
  ctx: TestContext,
  userId: string,
  boxId: string
): Promise<void> {
  const user = await ctx.pb.collection("users").getOne(userId);
  const boxes = (user.recipe_boxes as string[]) || [];
  if (!boxes.includes(boxId)) {
    await ctx.pb.collection("users").update(userId, {
      recipe_boxes: [...boxes, boxId],
    });
  }
}

// ─── Utility ────────────────────────────────────────────────

export function testId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

// ─── vitest e2e config ──────────────────────────────────────

/**
 * The shared `test` block for every app's `vitest.e2e.config.ts`.
 *
 * All six were byte-identical 18-liners: same include glob, same node
 * environment, same 30s timeouts, same `PB_TEST_URL` fallback. This collapses
 * each to a one-liner — `export default defineConfig({ test: e2eTestConfig() })`
 * — so the `:8091` fallback (and the timeouts) live in exactly one place.
 *
 * We return a plain object instead of calling vitest's `defineConfig` here so
 * this module doesn't pull `vitest/config` into the (Playwright-loaded)
 * import graph of the rest of test-utils; the per-app config file already
 * imports `defineConfig` and wraps the result.
 *
 * `PB_TEST_URL` is read from `process.env` (set by `infra/test-env.sh` /
 * `deploy.sh` for the worktree), falling back to {@link PB_TEST_URL_FALLBACK}.
 */
export function e2eTestConfig() {
  return {
    include: ["src/e2e/**/*.e2e.test.ts"],
    environment: "node" as const,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      PB_TEST_URL: process.env.PB_TEST_URL || PB_TEST_URL_FALLBACK,
    },
  };
}
