/**
 * Default life-tracker manifest for NEW users.
 *
 * A MINIMAL type-demo starter set — one trackable per field type — copied into
 * `life_logs.manifest` on first `getOrCreateLog`. Generically named (Water,
 * Mood, Note, Movement, Floss) so a brand-new user gets a working dashboard
 * that demonstrates every input shape, not the system owner's personal 17.
 *
 * Field-type coverage:
 *   - number   → Water (oz), Movement.minutes (min)
 *   - rating   → Mood (scale 5)
 *   - text     → Note
 *   - category → Movement.kind (labels[kind])
 *   - bool     → Floss
 *
 * Importable by both the seeding path (packages/backend/.../pocketbase/life.ts)
 * and tests. The PB backfill migration mirrors scott's 1:1 translation
 * separately in goja JS — this module is ONLY the new-user starter set.
 */
import type { LifeManifest } from "./types/life";

export const DEFAULT_LIFE_MANIFEST: LifeManifest = {
  trackables: [
    {
      id: "water",
      label: "Water",
      group: "body",
      fields: [{ key: "volume", type: "number", unit: "oz", defaultValue: 8 }],
    },
    {
      id: "mood",
      label: "Mood",
      group: "mind",
      fields: [{ key: "rating", type: "rating", scale: 5 }],
    },
    {
      id: "note",
      label: "Note",
      group: "mind",
      fields: [{ key: "text", type: "text" }],
    },
    {
      id: "movement",
      label: "Movement",
      group: "body",
      fields: [
        {
          key: "kind",
          type: "category",
          options: ["walk", "run", "bike", "lift", "yoga", "other"],
        },
        { key: "duration", type: "number", unit: "min", defaultValue: 30 },
      ],
    },
    {
      id: "floss",
      label: "Floss",
      group: "body",
      fields: [{ key: "done", type: "bool", defaultValue: 1 }],
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
