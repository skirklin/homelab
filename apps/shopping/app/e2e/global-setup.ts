/**
 * Playwright globalSetup for the shopping app.
 *
 * Runs once before any spec and makes the run hermetic + brain-dead-simple:
 *   1. `ensureTestEnvUp()` — idempotently brings the per-worktree test PB +
 *      API containers up (no-op if already healthy), so a cold
 *      `pnpm --filter @kirkl/shopping test:playwright` just works.
 *   2. Probe PB + API health at the resolved per-worktree URLs and abort
 *      with a clear message if either is down.
 *   3. WIPE shopping's own data so every run starts clean: the
 *      shopping_items / shopping_lists / shopping_trips collections plus the
 *      test users' shopping_slugs map. Clearing slugs is what kills the
 *      "you already have a list called X" non-idempotency (the bug the
 *      RUN_ID suffix in helpers.ts was working around).
 *   4. Seed the two test users the specs sign in as.
 *
 * Wipe-before, not teardown-after: a crashed run must never poison the next
 * one — starting-clean is the invariant.
 *
 * The shopping sharing spec calls /fn/sharing/list-info (the Hono API
 * service), so the API must be up too.
 */
import PocketBase from "pocketbase";
import {
  resolveTestPbUrl,
  resolveDevApiTarget,
  ensureTestEnvUp,
} from "@kirkl/vite-preset";
import { wipeCollections, clearUserFields } from "@kirkl/shared/test-utils";

// playwright.config.ts sets PB_TEST_URL via resolveTestPbUrl(); fall back to
// the helper for a manual `tsx global-setup.ts` invocation.
const PB_URL = process.env.PB_TEST_URL || resolveTestPbUrl();
const API_URL =
  process.env.VITE_API_URL || process.env.TEST_API_URL || resolveDevApiTarget();

const TEST_EMAIL = "playwright@test.local";
const TEST_EMAIL_2 = "playwright2@test.local";
const TEST_PASSWORD = "testpassword123";

// Shopping's own collections — and nothing else. Items before lists so a
// list-cleanup hook never trips over orphaned items.
const SHOPPING_COLLECTIONS = ["shopping_items", "shopping_lists", "shopping_trips"];

/** Find-or-create a test user and force a known password. */
async function ensureUser(pb: PocketBase, email: string, name: string) {
  try {
    const existing = await pb
      .collection("users")
      .getFirstListItem(`email = "${email}"`, { $autoCancel: false });
    await pb.collection("users").update(
      existing.id,
      { password: TEST_PASSWORD, passwordConfirm: TEST_PASSWORD },
      { $autoCancel: false }
    );
  } catch {
    await pb.collection("users").create(
      {
        email,
        password: TEST_PASSWORD,
        passwordConfirm: TEST_PASSWORD,
        name,
      },
      { $autoCancel: false }
    );
  }
}

async function globalSetup() {
  // 1. Bring the env up (idempotent). Throws + aborts the run if it can't.
  ensureTestEnvUp();

  console.log(`Verifying test env (PB=${PB_URL}, API=${API_URL})...`);

  // 2. Probe PB + API.
  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  try {
    await pb.health.check();
  } catch {
    throw new Error(
      `PocketBase not running at ${PB_URL}. Start the test env with: pnpm test:env:up`
    );
  }
  try {
    const resp = await fetch(`${API_URL}/health`);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
  } catch (e) {
    throw new Error(
      `API service not running at ${API_URL}. Start the test env with: pnpm test:env:up\n${e}`
    );
  }

  // Auth as admin (create the canonical test superuser if absent).
  try {
    await pb
      .collection("_superusers")
      .authWithPassword("test-admin@test.local", "testpassword1234");
  } catch {
    await pb.collection("_superusers").create({
      email: "test-admin@test.local",
      password: "testpassword1234",
      passwordConfirm: "testpassword1234",
    });
    await pb
      .collection("_superusers")
      .authWithPassword("test-admin@test.local", "testpassword1234");
  }

  // 3. Wipe shopping's own data + clear every user's shopping_slugs so the
  //    name-collision guard starts fresh. Scope to shopping's collections.
  await wipeCollections(pb, SHOPPING_COLLECTIONS);
  await clearUserFields(pb, { shopping_slugs: {} });

  // 4. Seed (with a known password) the two test users the specs sign in as.
  await ensureUser(pb, TEST_EMAIL, "Playwright Test User");
  await ensureUser(pb, TEST_EMAIL_2, "Playwright Test User 2");

  console.log("Test env ready (shopping data wiped, users seeded).");
}

export default globalSetup;
