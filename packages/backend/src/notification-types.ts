/**
 * Single source of truth for Web-Push `data.type` values and their
 * service-worker routing config.
 *
 * THE BUG THIS FIXES
 * ------------------
 * The push service worker (`apps/{home,upkeep,life}/app/public/push-sw.js`)
 * was a hand-maintained, byte-identical copy in three apps that branched on a
 * literal `data.type` string at two sites (the `push` show + the
 * `notificationclick` deep-link). It only knew `household_task_due` and
 * `life_tracker_sample`. Meanwhile the senders in
 * `services/api/src/lib/notifications/*` had grown FOUR more types
 * (`task_attention`, `life_reminder`, `travel_morning`, `travel_evening`) that
 * the SW never routed — they only "worked" by falling through to the generic
 * `data.url` branch, which happened to be set because those senders also pass a
 * url. Any future type that forgot a url would have silently shown a bare
 * notification that opened the app root.
 *
 * THE FIX
 * -------
 * This registry is the ONE place every `data.type` is declared, with its SW
 * routing config. Senders import `NotificationType` so a typo can't ship. The
 * SW is generated from this registry (see the `.js`/JSON mirror + lockstep test
 * under `apps/.../public/`) and routes data-driven, so:
 *   - adding a type is a single entry here, and
 *   - every type the senders emit is provably routed (the lockstep test fails
 *     if the SW mirror drifts from this registry).
 *
 * This mirrors the repo's `pb-json.js` / pb-hook mirror discipline: a TS source
 * of truth + a checked-in artifact + a test that asserts they match.
 *
 * ROUTING SEMANTICS (consumed by push-sw.js)
 * ------------------------------------------
 *   tag                — `Notification.tag`; same-tag notifications collapse.
 *   requireInteraction — keep the notification up until the user acts.
 *   quickRatingActions — render 1..5 quick-rating action buttons when the
 *                        payload carries `quickRatingId` + `quickRatingMax`
 *                        (life sampler only). When absent it falls back to a
 *                        generic Respond/Later pair.
 *   click              — what a tap opens:
 *                          { kind: "url" }            → resolve `data.url`
 *                            against the SW origin (the default for everything;
 *                            senders pass a SAME-ORIGIN relative path via
 *                            `buildUrl`, so per-origin auth is preserved).
 *                          { kind: "fixed", path }    → always open `path`.
 *                          { kind: "sample" }         → open the life sampler
 *                            and postMessage SAMPLE_REQUESTED (rating quick-
 *                            actions are handled separately by the SW).
 *
 * The `click.kind === "url"` default means a sender that sets `buildUrl`/`url`
 * needs NO special SW branch — which is exactly why the four un-routed types
 * still happened to open the right place. Declaring them here makes that
 * explicit and testable instead of accidental.
 */

export interface NotificationRouting {
  /** `Notification.tag` to collapse duplicates, when set. */
  tag?: string;
  /** Keep the notification on-screen until the user interacts. */
  requireInteraction?: boolean;
  /** Render 1..max quick-rating action buttons from `quickRatingId`/`quickRatingMax`. */
  quickRatingActions?: boolean;
  /** What a tap opens. Defaults conceptually to resolving `data.url`. */
  click:
    | { kind: "url" }
    | { kind: "fixed"; path: string }
    | { kind: "sample"; path: string };
}

export const NOTIFICATION_TYPES = {
  /** Upkeep: a recurring household chore is due. Collapses across chores. */
  household_task_due: {
    tag: "upkeep-tasks",
    click: { kind: "fixed", path: "/upkeep" },
  },
  /** Deadlines/asap: a one-shot todo needs attention. Deep-links via `data.url`. */
  task_attention: {
    click: { kind: "url" },
  },
  /** Life sampler: random check-in with 1..5 quick-rating actions. */
  life_tracker_sample: {
    requireInteraction: true,
    quickRatingActions: true,
    click: { kind: "sample", path: "/life?sample=true" },
  },
  /** Life fixed reminder (morning/evening/weekly/any View). Deep-links via `data.url`. */
  life_reminder: {
    click: { kind: "url" },
  },
  /** Travel: morning "today's plan". Deep-links via `data.url`. */
  travel_morning: {
    click: { kind: "url" },
  },
  /** Travel: evening "reflect on today". Deep-links via `data.url`. */
  travel_evening: {
    click: { kind: "url" },
  },
} as const satisfies Record<string, NotificationRouting>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;
