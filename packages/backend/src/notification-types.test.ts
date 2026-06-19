/**
 * Lockstep guard: the checked-in push service workers must match the registry.
 *
 * `apps/{home,upkeep,life}/app/public/push-sw.js` are GENERATED from
 * `NOTIFICATION_TYPES` via `scripts/gen-push-sw.ts` (rendered by
 * `push-sw-template.ts`). This test re-runs that render in memory and asserts
 * every checked-in copy is byte-identical, so a stale SW (e.g. a registry
 * change without re-running the generator) fails CI instead of silently
 * shipping a SW that drops a notification type — the exact drift this whole
 * change fixes. Mirrors the repo's pb-json / pb-hook mirror-test discipline.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { NOTIFICATION_TYPES } from "./notification-types";
import { renderPushSw, PUSH_SW_APPS, pushSwRelPath } from "./push-sw-template";

// This file lives at packages/backend/src/, so the repo root is three up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("push-sw lockstep with NOTIFICATION_TYPES", () => {
  const expected = renderPushSw();

  for (const app of PUSH_SW_APPS) {
    it(`apps/${app} push-sw.js matches the generated SW`, () => {
      const actual = readFileSync(join(REPO_ROOT, pushSwRelPath(app)), "utf8");
      expect(actual).toBe(expected);
    });
  }

  it("every registered type is embedded in the generated SW", () => {
    for (const type of Object.keys(NOTIFICATION_TYPES)) {
      expect(expected).toContain(`"${type}"`);
    }
  });

  it("each type's click kind is one the SW handles", () => {
    // The runtime SW branches on click.kind === "fixed" | "sample"; "url" is the
    // default branch. A new kind would need a new SW branch — assert none slips
    // in un-handled.
    for (const route of Object.values(NOTIFICATION_TYPES)) {
      expect(["url", "fixed", "sample"]).toContain(route.click.kind);
    }
  });
});
