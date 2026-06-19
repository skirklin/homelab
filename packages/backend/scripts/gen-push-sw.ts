/**
 * Generate the Web-Push service worker (`push-sw.js`) for every app that ships
 * one, from the single `NOTIFICATION_TYPES` registry in
 * `src/notification-types.ts` (rendered by `src/push-sw-template.ts`).
 *
 * WHY THIS EXISTS
 * ---------------
 * `apps/{home,upkeep,life}/app/public/push-sw.js` used to be three byte-
 * identical, hand-maintained copies that branched on literal `data.type`
 * strings — and had drifted from the senders (they only knew two of the six
 * emitted types). This script makes the SW a pure function of the registry:
 *   - the routing table is emitted from `NOTIFICATION_TYPES`, so adding a type
 *     is one registry entry; and
 *   - all three app copies are written identically, so they can't drift apart.
 *
 * The `notification-types.test.ts` lockstep test re-runs `renderPushSw()` in
 * memory and asserts each checked-in `push-sw.js` matches byte-for-byte, so a
 * stale copy fails CI (mirrors the repo's pb-json / pb-hook mirror discipline).
 *
 * USAGE
 *   pnpm --filter @homelab/backend gen:push-sw          # write the files
 *   pnpm --filter @homelab/backend gen:push-sw --check  # verify, non-zero on drift
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPushSw, PUSH_SW_APPS, pushSwRelPath } from "../src/push-sw-template";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

function swAbsPath(app: string): string {
  return join(REPO_ROOT, pushSwRelPath(app));
}

function main(): void {
  const check = process.argv.includes("--check");
  const expected = renderPushSw();
  let drift = false;

  for (const app of PUSH_SW_APPS) {
    const path = swAbsPath(app);
    if (check) {
      let actual = "";
      try {
        actual = readFileSync(path, "utf8");
      } catch {
        actual = "";
      }
      if (actual !== expected) {
        console.error(`[gen-push-sw] DRIFT: ${path} is out of date`);
        drift = true;
      }
    } else {
      writeFileSync(path, expected);
      console.log(`[gen-push-sw] wrote ${path}`);
    }
  }

  if (check && drift) {
    console.error("[gen-push-sw] run `pnpm --filter @homelab/backend gen:push-sw` to regenerate");
    process.exit(1);
  }
  if (check) console.log("[gen-push-sw] all copies up to date");
}

main();
