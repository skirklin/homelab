/**
 * The default Views, default View-tracked vocab, and default notifications that
 * reproduce TODAY'S three code-defined sessions (morning / evening / weekly)
 * EXACTLY as data. These are the `DEFAULT_*` fallbacks the `useViews` /
 * `useNotifications` resolvers return when a log's `manifest.views` /
 * `manifest.notifications` is `undefined` (legacy / un-customized logs).
 *
 * Phase B1 is FULLY ADDITIVE: nothing here is rendered or scheduled yet. The
 * ViewRunner consumes `DEFAULT_VIEWS` in Phase B2; the notification cron
 * consumes `DEFAULT_NOTIFICATIONS` in Phase B4. The Phase-C migration
 * materializes `DEFAULT_VIEW_TRACKABLES` into each log's `manifest.trackables`.
 *
 * Source of truth for the prompt text / order / placeholders below is today's
 * `apps/life/app/src/manifest.ts` `SESSIONS` array — kept byte-faithful so the
 * eventual data-driven renderer reproduces the wizards verbatim.
 *
 * ── The split-collision id map (design §3) ──────────────────────────────────
 * Today's session prompts collide on `entries[].name` across sessions
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
 * prompt text as `prompt`/`hint`, and the energy `rated` row keeps the 1–5
 * scale via `ratingLabel`. These are NON-HIDDEN (so Views can render them); the
 * `noted`-shape exclusion (Phase A) is what keeps them off the input surfaces.
 */
export const DEFAULT_VIEW_TRACKABLES: LifeManifestTrackable[] = [
  // ── Morning ──
  {
    id: "gratitude",
    label: "Gratitude",
    shape: "noted",
    prompt: "What are you grateful for?",
    hint: "One thing is plenty.",
  },
  {
    id: "daily_intention",
    label: "Daily intention",
    shape: "noted",
    prompt: "What's the plan for today?",
    hint: "What are you doing, and when? Worth a glance at your calendar.",
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
    refs: [{ token: "plan", fromTrackable: "daily_intention", within: "day" }],
  },
  {
    id: "daily_win",
    label: "Daily win",
    shape: "noted",
    prompt: "One thing that went well",
    hint: "However small.",
  },
  {
    id: "daily_lesson",
    label: "Daily lesson",
    shape: "noted",
    prompt: "What did today show you?",
    hint: "Optional — something surprising, something confirmed, anything.",
  },
  // ── Weekly ──
  {
    id: "highlights",
    label: "Highlights",
    shape: "noted",
    prompt: "What's worth remembering from this week?",
    hint: "The moments you'd want to find later.",
  },
  {
    id: "lows",
    label: "Lows",
    shape: "noted",
    prompt: "What was hard?",
    hint: "Honest, not heavy.",
  },
  {
    id: "weekly_lesson",
    label: "Weekly lesson",
    shape: "noted",
    prompt: "What did this week teach you?",
    hint: "What clicked, or what got clearer.",
  },
  {
    id: "weekly_intention",
    label: "Weekly intention",
    shape: "noted",
    prompt: "One intention for the week ahead?",
    hint: "Where do you want your attention?",
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
 * The default scheduled nudges — the three FIXED session reminders only.
 *
 * Placeholder default times are used here (07:30 / 21:00 / 19:00). Per-user
 * reminder-time reconciliation (copying each log's existing
 * `morningReminderTime` / `eveningReminderTime` / `weeklyReminderTime` columns
 * into these) AND the random-sampling (`{kind:"random"}`) notification are
 * Phase B4 — deliberately NOT modeled here.
 *
 * The weekly notification fires on Sunday (`weekday: 0`) and `subsumes` the
 * evening reminder on its day, reproducing today's "evening is suppressed when
 * the weekly review fires" Sunday behavior.
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
