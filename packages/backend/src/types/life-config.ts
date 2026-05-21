/**
 * Shared, system-wide life-tracker config.
 *
 * The life app's random-sample push notifications used to be configured
 * per-log in a `life_logs.manifest` JSON column. That column was abandoned
 * weeks ago when the frontend manifest moved to code (apps/life/.../manifest.ts)
 * but the api-service scheduler kept reading the stale column for prompt
 * labels. To keep the api scheduler, the life UI, and the SampleResponseModal
 * working off one definition, the random-sample config now lives here.
 *
 * If we ever want per-user opt-out, add a `random_samples_enabled` boolean
 * on `life_logs` and gate on that — do NOT resurrect the manifest JSON column.
 */

export interface LifeSampleQuestion {
  /** Stable identifier — also the key under `life_events.data` for the response. */
  id: string;
  /** Currently only "rating" is sampled; the union is wider to match the UI. */
  type: "rating" | "text" | "number";
  label: string;
  /** For rating prompts; defaults to 5 in the UI if absent. */
  max?: number;
  /** For number prompts. */
  min?: number;
  placeholder?: string;
}

export interface LifeRandomSamplesConfig {
  enabled: boolean;
  /** How many prompts to fire per day. */
  timesPerDay: number;
  /** `[startHour, endHour]` in 24h wall-clock; prompts are jittered within. */
  activeHours: [number, number];
  /** IANA tz; api scheduler falls back to the user's tz / UTC if unset. */
  timezone?: string;
  questions: LifeSampleQuestion[];
}

/**
 * The one config. Edited here, consumed by:
 *   - the api scheduler in services/api/src/lib/notifications/life.ts
 *   - the life UI (LifeDashboard, SettingsModal, Visualizations, SampleResponseModal)
 *
 * Solo-user app, code-driven manifest, no UI editor.
 */
export const RANDOM_SAMPLES: LifeRandomSamplesConfig = {
  enabled: true,
  timesPerDay: 3,
  activeHours: [9, 22],
  timezone: "America/Los_Angeles",
  questions: [
    { id: "mood", type: "rating", label: "How happy do you feel?", max: 5 },
    { id: "content", type: "rating", label: "How anxious/content are you feeling?", max: 5 },
  ],
};
