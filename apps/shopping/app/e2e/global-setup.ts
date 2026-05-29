/**
 * Playwright globalSetup for the shopping app.
 *
 * The shared `setupTestEnv` helper makes the run hermetic: bring the
 * per-worktree PB + API up (idempotent) → probe both → admin auth-or-create →
 * WIPE shopping's own collections → clear every user's `shopping_slugs` map →
 * seed the two fixed test users the specs sign in as.
 *
 * Clearing `shopping_slugs` is what kills the "you already have a list called
 * X" non-idempotency (the bug the now-deleted RUN_ID suffix in helpers.ts was
 * working around). Wipe-before, not teardown-after: a crashed run must never
 * poison the next.
 *
 * The shopping sharing spec calls /fn/sharing/list-info (the Hono API
 * service), so the API must be up too — `setupTestEnv` probes it.
 */
import {
  resolveTestPbUrl,
  resolveDevApiTarget,
  ensureTestEnvUp,
} from "@kirkl/vite-preset";
import { setupTestEnv } from "@kirkl/shared/test-utils";

// Shopping's own collections — and nothing else. Items before lists so a
// list-cleanup hook never trips over orphaned items.
const SHOPPING_COLLECTIONS = ["shopping_items", "shopping_lists", "shopping_trips"];

export default () =>
  setupTestEnv({
    pbUrl: process.env.PB_TEST_URL || resolveTestPbUrl(),
    apiUrl:
      process.env.VITE_API_URL || process.env.TEST_API_URL || resolveDevApiTarget(),
    ensureUp: ensureTestEnvUp,
    collections: SHOPPING_COLLECTIONS,
    userFields: { shopping_slugs: {} },
    seedUsers: [
      { email: "playwright@test.local", name: "Playwright Test User" },
      { email: "playwright2@test.local", name: "Playwright Test User 2" },
    ],
  });
