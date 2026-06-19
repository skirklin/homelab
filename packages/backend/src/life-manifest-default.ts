/**
 * Default life-tracker vocabulary for NEW users.
 *
 * A MINIMAL starter set — one trackable per SHAPE — copied into
 * `life_logs.manifest` on first `getOrCreateLog`. Generically named (Water,
 * Exercise, Floss, Mood) so a brand-new user gets a working dashboard that
 * demonstrates every shape widget, not the system owner's personal list.
 *
 * Shape coverage:
 *   - took     → Water (8 oz)
 *   - did      → Exercise (30 min, optional intensity rating)
 *   - happened → Floss
 *   - rated    → Mood
 *
 * Importable by both the seeding path (packages/backend/.../pocketbase/life.ts)
 * and tests. The PB shape migration rewrites EXISTING manifests separately in
 * goja JS — this module is ONLY the new-user starter set.
 *
 * `views` + `notifications` are seeded as the resolved defaults
 * (`DEFAULT_VIEWS` / `DEFAULT_NOTIFICATIONS`) so a brand-new log ALWAYS persists
 * both keys as arrays. The in-app View/Notification editor edits these keys
 * directly and would throw `*_not_found` if it rendered an unpersisted
 * resolved-default fallback. Existing logs are materialized separately by the
 * Phase D migration (migrate-reminder-columns-to-notifications.ts) — so this
 * seed only affects logs created after deploy, and the cron's column fallback
 * for existing users is unchanged. New users get the 3 default reminders
 * (07:30/21:00/19:00) + 3 session views by default (reminders only push if the
 * user actually subscribes to push).
 */
import { DEFAULT_NOTIFICATIONS, DEFAULT_VIEWS } from "./life-view-defaults";
import type { LifeManifest } from "./types/life";

export const DEFAULT_LIFE_MANIFEST: LifeManifest = {
  trackables: [
    {
      id: "water",
      label: "Water",
      shape: "took",
      group: "body",
      defaultUnit: "oz",
      defaultAmount: 8,
    },
    {
      id: "exercise",
      label: "Exercise",
      shape: "did",
      group: "body",
      defaultDuration: 30,
      ratingLabel: "intensity",
    },
    {
      id: "floss",
      label: "Floss",
      shape: "happened",
      group: "body",
    },
    {
      id: "mood",
      label: "Mood",
      shape: "rated",
      group: "mind",
    },
  ],
  views: DEFAULT_VIEWS,
  notifications: DEFAULT_NOTIFICATIONS,
};

/**
 * Fresh copy of the default manifest. Always returns a deep clone so callers
 * can mutate the result (e.g. before persisting) without aliasing the shared
 * constant.
 */
export function defaultLifeManifest(): LifeManifest {
  return structuredClone(DEFAULT_LIFE_MANIFEST);
}
