/**
 * The default Views, default View-tracked vocab, and default notifications that
 * reproduce the original three code-defined sessions (morning / evening /
 * weekly) EXACTLY as data. Those sessions lived in a `SESSIONS` const that was
 * removed in Phase B3.3; this file is now the only home for that prompt set.
 * These are the `DEFAULT_*` fallbacks the `useViews` /
 * `useNotifications` resolvers return when a log's `manifest.views` /
 * `manifest.notifications` is `undefined` (legacy / un-customized logs).
 *
 * The ViewRunner renders `DEFAULT_VIEWS` (for logs that haven't customized);
 * the notification cron schedules `DEFAULT_NOTIFICATIONS`; and
 * `DEFAULT_VIEW_TRACKABLES` is seeded into each log's `manifest.trackables`.
 *
 * Source of truth for the prompt text / order / placeholders below was the
 * original code-defined session prompts — kept byte-faithful so the data-driven
 * renderer reproduces the wizards verbatim.
 *
 * ── The split-collision id map (design §3) ──────────────────────────────────
 * Those session prompts collide on `entries[].name` across sessions
 * (morning.intention vs weekly.intention; evening.lesson vs weekly.lesson). As
 * distinct VOCAB ids they must split, so each gets its own `subject_id` series:
 *
 *   morning.gratitude          → gratitude          (noted)
 *   morning.intention          → daily_intention    (noted)  [split]
 *   morning.energy             → energy             (rated)
 *   evening.intention_followup → intention_followup (noted, refs daily_intention)
 *   evening.win                → daily_win          (noted)
 *   evening.lesson             → daily_lesson       (noted)  [split]
 *   weekly.highlights          → highlights         (noted)
 *   weekly.lows                → lows               (noted)
 *   weekly.lesson              → weekly_lesson      (noted)  [split]
 *   weekly.intention           → weekly_intention   (noted)  [split]
 */
import type {
  LifeManifestTrackable,
  LifeView,
  LifeNotification,
} from "./types/life";

/**
 * The vocab rows the default Views reference. Each carries the original session
 * prompt text byte-faithfully across THREE distinct fields — `prompt` = the
 * SESSIONS `label`, `hint` = the SESSIONS `hint`, `placeholder` = the SESSIONS
 * `placeholder` (the textarea ghost text) — so the ViewRunner reproduces the
 * wizards exactly. The energy `rated` row keeps the 1–5 scale via `ratingLabel`.
 * These are NON-HIDDEN (so Views can render them); the `noted`-shape exclusion
 * is what keeps them off the input surfaces.
 */
export const DEFAULT_VIEW_TRACKABLES: LifeManifestTrackable[] = [
  // ── Morning ──
  {
    id: "gratitude",
    label: "Gratitude",
    shape: "noted",
    prompt: "What are you grateful for?",
    placeholder: "One thing is plenty.",
  },
  {
    id: "daily_intention",
    label: "Daily intention",
    shape: "noted",
    prompt: "What's the plan for today?",
    hint: "What are you doing, and when? Worth a glance at your calendar.",
    placeholder: "Priorities, rough timing, the shape of the day.",
  },
  {
    id: "energy",
    label: "Energy",
    shape: "rated",
    ratingLabel: "Energy",
    prompt: "Energy",
    hint: "How's the tank look?",
  },
  // ── Evening ──
  {
    id: "intention_followup",
    label: "Intention follow-up",
    shape: "noted",
    prompt: "How did the plan hold up?",
    hint: "This morning's plan: “{plan}”",
    placeholder: "How did it turn out? Honest beats tidy.",
    refs: [{ token: "plan", fromTrackable: "daily_intention", within: "day" }],
  },
  {
    id: "daily_win",
    label: "Daily win",
    shape: "noted",
    prompt: "One thing that went well",
    placeholder: "However small.",
  },
  {
    id: "daily_lesson",
    label: "Daily lesson",
    shape: "noted",
    prompt: "What did today show you?",
    placeholder: "Optional — something surprising, something confirmed, anything.",
  },
  // ── Weekly ──
  {
    id: "highlights",
    label: "Highlights",
    shape: "noted",
    prompt: "What's worth remembering from this week?",
    placeholder: "The moments you'd want to find later.",
  },
  {
    id: "lows",
    label: "Lows",
    shape: "noted",
    prompt: "What was hard?",
    placeholder: "Honest, not heavy.",
  },
  {
    id: "weekly_lesson",
    label: "Weekly lesson",
    shape: "noted",
    prompt: "What did this week teach you?",
    placeholder: "What clicked, or what got clearer.",
  },
  {
    id: "weekly_intention",
    label: "Weekly intention",
    shape: "noted",
    prompt: "One intention for the week ahead?",
    placeholder: "Where do you want your attention?",
  },
];

/**
 * The three default Views (morning / evening / weekly), rendered `guided`,
 * reproducing today's session wizards. Item order matches the prompt order in
 * `SESSIONS`. Non-capture blocks (`tasks_due`, `banner`) lead, per the renderer
 * contract — matching today's MorningUpkeepHeader + week-intention banner that
 * sit above the prompts.
 *
 * The `id` of each View is the old session slug (`morning` / `evening` /
 * `weekly`) so `labels.view` is stable across the cutover.
 */
export const DEFAULT_VIEWS: LifeView[] = [
  {
    id: "morning",
    title: "Morning",
    greeting: "Good morning. A few questions before the day gets going.",
    icon: "sun",
    render: "guided",
    items: [
      { kind: "tasks_due" },
      {
        kind: "banner",
        text: "This week: {wk}",
        refs: [
          { token: "wk", fromTrackable: "weekly_intention", within: "week" },
        ],
      },
      { kind: "capture", trackableId: "gratitude" },
      { kind: "capture", trackableId: "daily_intention" },
      { kind: "capture", trackableId: "energy" },
    ],
  },
  {
    id: "evening",
    title: "Evening",
    greeting: "Wind-down time. A few quick reflections.",
    icon: "moon",
    render: "guided",
    items: [
      // Optional: drops when there's no morning intention to follow up on —
      // the renderer drops a capture whose required ref fails (no nudge).
      { kind: "capture", trackableId: "intention_followup", optional: true },
      { kind: "capture", trackableId: "daily_win" },
      { kind: "capture", trackableId: "daily_lesson", optional: true },
    ],
  },
  {
    id: "weekly",
    title: "Weekly review",
    greeting: "Time to look back on the week.",
    icon: "calendar",
    render: "guided",
    items: [
      { kind: "capture", trackableId: "highlights" },
      { kind: "capture", trackableId: "lows", optional: true },
      { kind: "capture", trackableId: "weekly_lesson", optional: true },
      { kind: "capture", trackableId: "weekly_intention" },
    ],
  },
];

/**
 * The default scheduled nudges — the three FIXED session reminders only, with
 * placeholder times (07:30 / 21:00 / 19:00). The weekly notification fires on
 * Sunday (`weekday: 0`) and `subsumes` the evening reminder on its day.
 *
 * This is now an INERT fallback only: `useNotifications` resolves an
 * `undefined` `manifest.notifications` to this default so an editor never
 * renders blank. New logs seed `manifest.notifications: []` (see
 * life-manifest-default.ts) and every existing log was materialized with a real
 * array by the Phase D column→manifest migration, so the cron never relies on
 * this — `resolveNotifications` reads `manifest.notifications` and falls back to
 * `[]`, not to these defaults.
 *
 * Historical note: these BARE ids (`morning`/`evening`/`weekly`) deliberately
 * differ from the `*-reminder` ids the Phase D migration materialized (which
 * key `reminder_state`); the migration used the migration-time
 * column-reconstruction, never this default. (Cross-ref: `LifeManifest.notifications`
 * doc in `packages/backend/src/types/life.ts`.)
 */
export const DEFAULT_NOTIFICATIONS: LifeNotification[] = [
  {
    id: "morning",
    target: "morning",
    strategy: { kind: "fixed", cadence: "daily", time: "07:30" },
  },
  {
    id: "evening",
    target: "evening",
    strategy: { kind: "fixed", cadence: "daily", time: "21:00" },
  },
  {
    id: "weekly",
    target: "weekly",
    strategy: {
      kind: "fixed",
      cadence: "weekly",
      time: "19:00",
      weekday: 0,
      subsumes: ["evening"],
    },
  },
];
