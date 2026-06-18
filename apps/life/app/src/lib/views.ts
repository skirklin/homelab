/**
 * Resolver hooks for the Unified Capture data model (Views + Notifications).
 *
 * Mirror of `useTrackables` / `useGoals` in [trackables.ts](./trackables.ts):
 * read the per-user manifest, fall back to the `DEFAULT_*` constants. These are
 * NEW hooks introduced in Phase B1 and consumed in Phase B2 (ViewRunner) /
 * Phase B4 (notification cron) — they are NOT called from any component yet,
 * and adding them changes no behavior.
 *
 * RESOLVE SEMANTICS (load-bearing): `manifest.views === undefined` falls back
 * to `DEFAULT_VIEWS`, but an explicit `[]` resolves to `[]` (Angela has Views
 * trimmed to none). Same for notifications. This is why the `?? DEFAULT`
 * pattern is correct: `?? ` only triggers on `null`/`undefined`, never on `[]`.
 */
import { useMemo } from "react";
import type { LifeView, LifeNotification } from "@homelab/backend";
import { DEFAULT_VIEWS, DEFAULT_NOTIFICATIONS } from "@homelab/backend";
import { useLifeContext } from "../life-context";

/** The capture Views for the current log, or the default session Views. */
export function useViews(): LifeView[] {
  const { state } = useLifeContext();
  return useMemo(
    () => state.log?.manifest?.views ?? DEFAULT_VIEWS,
    [state.log?.manifest],
  );
}

/** The scheduled nudges for the current log, or the default session reminders. */
export function useNotifications(): LifeNotification[] {
  const { state } = useLifeContext();
  return useMemo(
    () => state.log?.manifest?.notifications ?? DEFAULT_NOTIFICATIONS,
    [state.log?.manifest],
  );
}
