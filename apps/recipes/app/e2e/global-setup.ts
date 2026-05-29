/**
 * Playwright globalSetup for the recipes app.
 *
 * The shared `setupTestEnv` helper handles it: bring the per-worktree PB + API
 * up (idempotent) → probe both → admin auth-or-create → WIPE recipes' own
 * collections → clear every user's `recipe_boxes` pointer array (otherwise it
 * points at deleted box IDs). Wipe-before, not teardown-after: a crashed run
 * must never poison the next.
 *
 * The API service is required because:
 *   - createShareInvite() → POST /fn/sharing/invite (api service)
 *   - getOwnerInfo()       → GET  /fn/sharing/owner-info?ids=... (api service)
 * The actual invite redemption hits a PB JS hook (POST /api/sharing/redeem)
 * baked into infra/pocketbase/pb_hooks/sharing.pb.js, served directly off PB.
 * Recipes mints a fresh user per test (see fixtures.ts), so no `seedUsers`.
 */
import {
  resolveTestPbUrl,
  resolveDevApiTarget,
  ensureTestEnvUp,
} from "@kirkl/vite-preset";
import { setupTestEnv } from "@kirkl/shared/test-utils";

// Recipes' own collections — and nothing else. Recipes/events before boxes.
const RECIPE_COLLECTIONS = ["recipe_events", "recipes", "recipe_boxes"];

export default () =>
  setupTestEnv({
    pbUrl: process.env.PB_TEST_URL || resolveTestPbUrl(),
    apiUrl:
      process.env.VITE_API_URL || process.env.TEST_API_URL || resolveDevApiTarget(),
    ensureUp: ensureTestEnvUp,
    collections: RECIPE_COLLECTIONS,
    userFields: { recipe_boxes: [] },
  });
