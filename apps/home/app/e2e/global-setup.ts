/**
 * Playwright globalSetup for the home (shell) app.
 *
 * Home embeds shopping, recipes, upkeep, and travel as modules, so its specs
 * exercise all of their collections. The shared `setupTestEnv` helper does the
 * work (bring env up → probe PB + API → admin auth-or-create → wipe → clear
 * per-user pointers); we just hand it home's collection list + the per-user
 * pointer fields its modules write.
 *
 * Wipe-before, not teardown-after: a crashed run must never poison the next.
 * Home mints a fresh user per test (home.spec.ts signs UP a unique email), so
 * tests are already user-isolated — the wipe just keeps the shared test PB
 * from accumulating orphan records run over run, so no `seedUsers` here.
 */
import {
  resolveTestPbUrl,
  resolveDevApiTarget,
  ensureTestEnvUp,
} from "@kirkl/vite-preset";
import { setupTestEnv } from "@kirkl/shared/test-utils";

// Every collection home's embedded modules write to. Children before parents
// so cleanup hooks never trip over orphans:
//   - shopping: items → lists (+ trips)
//   - upkeep:   tasks/events → task_lists
//   - recipes:  events/recipes → boxes
//   - travel:   activities/itineraries → trips → logs
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
  "travel_trips",
  "travel_logs",
];

export default () =>
  setupTestEnv({
    pbUrl: process.env.PB_TEST_URL || resolveTestPbUrl(),
    apiUrl:
      process.env.VITE_API_URL || process.env.TEST_API_URL || resolveDevApiTarget(),
    ensureUp: ensureTestEnvUp,
    collections: HOME_COLLECTIONS,
    userFields: {
      shopping_slugs: {},
      household_slugs: {},
      travel_slugs: {},
      recipe_boxes: [],
    },
  });
