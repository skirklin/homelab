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
 */
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
};

/**
 * Fresh copy of the default manifest. Always returns a deep clone so callers
 * can mutate the result (e.g. before persisting) without aliasing the shared
 * constant.
 */
export function defaultLifeManifest(): LifeManifest {
  return structuredClone(DEFAULT_LIFE_MANIFEST);
}
