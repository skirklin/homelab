/**
 * Tiny helper for the e2e tests in this directory.
 *
 * Every e2e test needs a PB to talk to. Production PB is on :8091 (main
 * checkout's `docker compose -f docker-compose.test.yml up`), but parallel
 * worktrees each spin up their own PB on a deterministic per-worktree port
 * derived by `infra/test-env.sh` from the worktree basename. The worktree's
 * own `infra/test-env.sh up` sets `PB_URL` / `PB_TEST_URL` in the
 * environment of any process it spawns; vitest configs (and `pnpm test`
 * via dotenv loading of `.test-env-port`) propagate it.
 *
 * Tests should call this helper once near the top of the file:
 *
 *   const PB_URL = getPbTestUrl();
 *   process.env.PB_URL = PB_URL;   // so test-app.ts picks it up too
 *
 * Or for files that don't import test-app, just use the returned value:
 *
 *   const adminPb = new PocketBase(getPbTestUrl());
 *
 * The legacy default (:8091) is preserved so running a single test in
 * isolation with no env still works against the main-checkout PB.
 */
export function getPbTestUrl(): string {
  return process.env.PB_URL ?? process.env.PB_TEST_URL ?? "http://127.0.0.1:8091";
}
