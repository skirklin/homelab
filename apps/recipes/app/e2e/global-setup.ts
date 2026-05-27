/**
 * Verifies the per-worktree test PocketBase + API service are up before any
 * recipes spec runs. Mirrors apps/home/app/e2e/global-setup.ts (which is the
 * other suite that needs both PB and the API).
 *
 * The API service is required because:
 *   - createShareInvite() → POST /fn/sharing/invite (api service)
 *   - getOwnerInfo()       → GET  /fn/sharing/owner-info?ids=... (api service)
 * The actual invite redemption hits a PB JS hook (POST /api/sharing/redeem)
 * baked into infra/pocketbase/pb_hooks/sharing.pb.js, served directly off PB.
 */
import PocketBase from "pocketbase";
import { resolveDevApiTarget, resolveTestPbUrl } from "@kirkl/vite-preset";

// PB_TEST_URL is set in playwright.config.ts via resolveTestPbUrl(), but
// hold a fallback to the helper here too so a manual `tsx global-setup.ts`
// invocation still picks the per-worktree port.
const PB_URL = process.env.PB_TEST_URL || resolveTestPbUrl();
const API_URL = process.env.VITE_API_URL || process.env.TEST_API_URL || resolveDevApiTarget();

async function globalSetup() {
  console.log(`Verifying test env (PB=${PB_URL}, API=${API_URL})...`);

  const pb = new PocketBase(PB_URL);
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

  console.log("Test env ready.");
}

export default globalSetup;
