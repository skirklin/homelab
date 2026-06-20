/**
 * Shared, system-wide life-tracker config.
 *
 * Random-sample push notifications are app-wide (shared by every log), so
 * their schedule + question list live here in code rather than per-log on the
 * `life_logs.manifest` column. (The per-user manifest column is alive and well
 * for trackables/goals/views/notifications — it just isn't where the shared
 * random-sample config belongs.) Keeping it here lets the api scheduler, the
 * life UI, and the SampleResponseModal work off one definition.
 *
 * Each question points at a trackable in the caller's manifest vocab by id.
 * Responses are written as value-shaped events under `subject_id = trackableId`,
 * so they flow into the same series as manually-logged ratings — no parallel
 * "sample" table.
 *
 * Per-user opt-in lives on `life_logs.random_sampling_enabled`
 * (20260522_221130_life_random_sampling_enabled).
 */

export interface LifeSampleQuestion {
  /**
   * Trackable id — resolves against the caller's DB manifest vocab. Becomes
   * the `subject_id` of the resulting event so the response flows into the
   * same series as manual entries.
   */
  trackableId: string;
  /**
   * Push-notification body / modal prompt. Required (not optional) so the
   * api scheduler can label notifications without reading the caller's
   * manifest. The UI may still fall back to the trackable's own label if a
   * future question omits this.
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
