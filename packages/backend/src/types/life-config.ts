/**
 * Shared, system-wide life-tracker config.
 *
 * The life app's random-sample push notifications used to be configured
 * per-log in a `life_logs.manifest` JSON column. That column was abandoned
 * when the frontend manifest moved to code (apps/life/.../manifest.ts) and
 * is dropped by migration 0032. To keep the api scheduler, the life UI,
 * and the SampleResponseModal working off one definition, the random-sample
 * config now lives here.
 *
 * Post-collapse model: each question points at a Trackable in the life app
 * (apps/life/app/src/manifest.ts TRACKABLES). Responses are written as
 * value-shaped events under `subject_id = trackableId`, so they flow into
 * the same series as manually-logged ratings — no parallel "sample" table.
 *
 * Per-user opt-in lives on `life_logs.random_sampling_enabled`
 * (20260522_221130_life_random_sampling_enabled) — do NOT resurrect the
 * manifest JSON column.
 */

export interface LifeSampleQuestion {
  /**
   * Trackable id from the life app's TRACKABLES list. Becomes the
   * `subject_id` of the resulting event so the response flows into the
   * same series as manual entries.
   */
  trackableId: string;
  /**
   * Push-notification body / modal prompt. Required (not optional) so the
   * api scheduler can label notifications without importing the life
   * app's TRACKABLES list. The UI may still fall back to the trackable's
   * own label if a future question omits this.
   */
  label: string;
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
 *
 * Both questions point at rating trackables (mood, content) so the push
 * notification can offer 1-5 action buttons that the service worker turns
 * into a value-shaped event under that subject_id.
 */
export const RANDOM_SAMPLES: LifeRandomSamplesConfig = {
  enabled: true,
  timesPerDay: 3,
  activeHours: [9, 22],
  timezone: "America/Los_Angeles",
  questions: [
    { trackableId: "mood",    label: "How happy do you feel?" },
    { trackableId: "content", label: "How anxious/content are you feeling?" },
  ],
};
