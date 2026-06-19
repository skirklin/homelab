/**
 * Default life-tracker manifest for NEW users.
 *
 * A brand-new log seeds EMPTY — no starter trackables, no Views, no
 * notifications. The user builds their own vocab + capture surface from
 * scratch. (Earlier this seeded a one-per-shape demo set + DEFAULT_VIEWS +
 * DEFAULT_NOTIFICATIONS; that was dropped per the "start empty" directive.)
 *
 * All three keys are EXPLICIT empty arrays, NOT `undefined`. This is
 * load-bearing: the in-app View / notification editors edit `manifest.views`
 * and `manifest.notifications` in place, and an `undefined` key would make an
 * editor render the resolved DEFAULT_* fallback and then throw `*_not_found`
 * on the first edit (it would be operating on an array that was never
 * persisted). Seeding `[]` guarantees the editors always have a real array to
 * mutate.
 *
 * Importable by both the seeding path (packages/backend/.../pocketbase/life.ts)
 * and tests. Existing logs are unaffected — they were materialized separately
 * by the Phase D column→manifest migration; this seed only shapes logs created
 * after that deploy.
 */
import type { LifeManifest } from "./types/life";

export const DEFAULT_LIFE_MANIFEST: LifeManifest = {
  trackables: [],
  views: [],
  notifications: [],
};

/**
 * Fresh copy of the default manifest. Always returns a deep clone so callers
 * can mutate the result (e.g. before persisting) without aliasing the shared
 * constant.
 */
export function defaultLifeManifest(): LifeManifest {
  return structuredClone(DEFAULT_LIFE_MANIFEST);
}
