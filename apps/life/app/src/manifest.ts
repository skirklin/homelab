/**
 * Random-sample config re-export for the life app.
 *
 * Trackables, goals, and the capture Views (morning / evening / weekly) are all
 * per-user and data-defined now — trackables/goals live on `life_logs.manifest`
 * (read through [lib/trackables.ts](./lib/trackables.ts) / [lib/views.ts](./lib/views.ts)),
 * and the default Views/notifications live in `@homelab/backend`
 * (`DEFAULT_VIEWS` / `DEFAULT_NOTIFICATIONS`). The code-defined `SESSIONS` array
 * that this file used to own was removed in Phase B3.3 once the fanout migration
 * left no fat `*_session` events behind.
 *
 * This file now owns only the random-sample re-export: the schedule + question
 * list live in `@homelab/backend` so the api scheduler
 * (services/api/src/lib/notifications/life.ts) and the UI render the same
 * prompts. Re-exported under the local names so existing consumers
 * (SampleResponseModal, SettingsModal, LifeDashboard) don't churn their imports.
 */
export type {
  LifeSampleQuestion as SampleQuestion,
  LifeRandomSamplesConfig as RandomSamplesConfig,
} from "@homelab/backend";
export { RANDOM_SAMPLES } from "@homelab/backend";
