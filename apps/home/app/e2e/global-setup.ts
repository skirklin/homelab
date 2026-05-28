/**
 * Playwright globalSetup for the home (shell) app.
 *
 * Home embeds shopping, recipes, upkeep, and travel as modules, so its
 * specs exercise all of their collections. This setup:
 *   1. `ensureTestEnvUp()` — idempotently brings the per-worktree test PB +
 *      API containers up (no-op if already healthy), so a cold
 *      `pnpm --filter @kirkl/home test:playwright` just works.
 *   2. Probes PB + API health and aborts with a clear message if either's down.
 *   3. WIPEs every collection home's modules touch so each run starts clean,
 *      plus clears the per-user slug maps / recipe_boxes array that point at
 *      the wiped records.
 *
 * Wipe-before, not teardown-after: a crashed run must never poison the next.
 *
 * Home mints a fresh user per test (home.spec.ts signs UP a unique email),
 * so tests are already user-isolated; the wipe keeps the shared test PB from
 * accumulating orphan records run over run.
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

const ADMIN_EMAIL = "test-admin@test.local";
const ADMIN_PASSWORD = "testpassword1234";

// Every collection home's embedded modules write to. Children before parents
// so cleanup hooks never trip over orphans:
//   - shopping: items → lists (+ trips)
//   - upkeep:   tasks/events → task_lists
//   - recipes:  events/recipes → boxes
//   - travel:   activities/itineraries/day_entries → trips → logs
const HOME_COLLECTIONS = [
  "shopping_items",
  "shopping_lists",
  "shopping_trips",
  "task_events",
  "tasks",
  "task_lists",
  "recipe_events",
  "recipes",
  "recipe_boxes",
  "travel_activities",
  "travel_itineraries",
  "travel_day_entries",
  "travel_trips",
  "travel_logs",
];

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

  // Wipe every module's collections + clear the per-user pointer fields that
  // reference them, so the next run sees a truly clean slate.
  await wipeCollections(pb, HOME_COLLECTIONS);
  await clearUserFields(pb, {
    shopping_slugs: {},
    household_slugs: {},
    travel_slugs: {},
    recipe_boxes: [],
  });

  console.log("✓ Test environment ready (home module data wiped)\n");
}

export default globalSetup;
