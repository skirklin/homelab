/**
 * Playwright globalSetup for the recipes app.
 *
 * Runs once before any spec:
 *   1. `ensureTestEnvUp()` — idempotently brings the per-worktree test PB +
 *      API containers up (no-op if already healthy), so a cold
 *      `pnpm --filter @kirkl/recipes test:playwright` just works.
 *   2. Probe PB + API health and abort with a clear message if either's down.
 *   3. WIPE recipes' own data so every run starts clean: recipe_boxes /
 *      recipes / recipe_events, plus clear every user's recipe_boxes array
 *      (otherwise it points at deleted box IDs).
 *
 * Wipe-before, not teardown-after: a crashed run must never poison the next.
 *
 * The API service is required because:
 *   - createShareInvite() → POST /fn/sharing/invite (api service)
 *   - getOwnerInfo()       → GET  /fn/sharing/owner-info?ids=... (api service)
 * The actual invite redemption hits a PB JS hook (POST /api/sharing/redeem)
 * baked into infra/pocketbase/pb_hooks/sharing.pb.js, served directly off PB.
 */
import PocketBase from "pocketbase";
import {
  resolveDevApiTarget,
  resolveTestPbUrl,
  ensureTestEnvUp,
} from "@kirkl/vite-preset";
import { wipeCollections, clearUserFields } from "@kirkl/shared/test-utils";

// PB_TEST_URL is set in playwright.config.ts via resolveTestPbUrl(), but
// hold a fallback to the helper here too so a manual `tsx global-setup.ts`
// invocation still picks the per-worktree port.
const PB_URL = process.env.PB_TEST_URL || resolveTestPbUrl();
const API_URL = process.env.VITE_API_URL || process.env.TEST_API_URL || resolveDevApiTarget();

// Recipes' own collections — and nothing else. Recipes/events before boxes.
const RECIPE_COLLECTIONS = ["recipe_events", "recipes", "recipe_boxes"];

const ADMIN_EMAIL = "test-admin@test.local";
const ADMIN_PASSWORD = "testpassword1234";

async function globalSetup() {
  // 1. Bring the env up (idempotent). Throws + aborts the run if it can't.
  ensureTestEnvUp();

  console.log(`Verifying test env (PB=${PB_URL}, API=${API_URL})...`);

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

  // Auth as admin (create the canonical test superuser if absent) so the
  // wipe can delete records that user-scoped API rules would otherwise hide.
  try {
    await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  } catch {
    await pb.collection("_superusers").create({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      passwordConfirm: ADMIN_PASSWORD,
    });
    await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  }

  // Wipe recipes' own data + clear every user's recipe_boxes pointer array.
  await wipeCollections(pb, RECIPE_COLLECTIONS);
  await clearUserFields(pb, { recipe_boxes: [] });

  console.log("Test env ready (recipes data wiped).");
}

export default globalSetup;
