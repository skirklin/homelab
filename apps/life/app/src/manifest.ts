/**
 * Code-driven SESSION manifest for the life app.
 *
 * Trackables are now per-user and data-defined (persisted on
 * `life_logs.manifest`, read through [lib/trackables.ts](./lib/trackables.ts));
 * this file owns only the closed, code-defined set that stays in code:
 * sessions (morning / evening / weekly review) and the random-sample config
 * re-export.
 *
 * Session prompt ids are persisted in `life_events.entries[].name`. Don't
 * rename them in place — historical events keyed on the old id fall off.
 */
import type { SampleSchedule, LifeLog } from "@homelab/backend";

export type { SampleSchedule, LifeLog };

// ---------- Sessions ----------

export interface SessionPrompt {
  /** Key in the resulting event's entries. Don't rename without a migration. */
  id: string;
  /**
   * `sleep` is special: the step collects duration + optional quality rating
   * + optional notes and the runner writes them as ONE merged `sleep` event
   * (canonical did-shape entries) — never folded into the session event,
   * never split into a separate `sleep_quality` event.
   */
  type: "text" | "rating" | "number" | "checkbox" | "sleep";
  label: string;
  /** Optional sub-label / hint shown under the prompt. */
  hint?: string;
  placeholder?: string;
  /** For rating prompts. */
  max?: number;
  /** For number prompts. */
  min?: number;
  unit?: string;
  /** Allow the user to skip without setting a value. Default: true. */
  optional?: boolean;
  /**
   * If set, the prompt only renders when the SessionRunner can resolve the
   * named context. Today the only resolver is "morning_intention" which
   * looks up today's `morning_session` event and pulls its `intention` text
   * to substitute into `{context}` inside `hint`. When the context is
   * missing (no morning session today, or no intention answered), the
   * prompt is omitted entirely — never shown with a "you skipped this
   * morning" nudge, per the ROADMAP's anti-patterns.
   */
  contextKey?: "morning_intention";
}

export interface Session {
  /** Route slug — `/morning`, `/evening`, `/weekly`, etc. Also the event
   *  subject_id is `<id>_session`. */
  id: "morning" | "evening" | "weekly_review";
  title: string;
  /** One-line greeting shown at the top of the wizard. */
  greeting: string;
  prompts: SessionPrompt[];
}

export const SESSIONS: Session[] = [
  {
    id: "morning",
    title: "Morning",
    greeting: "Good morning. A few questions before the day gets going.",
    prompts: [
      {
        id: "sleep",
        type: "sleep",
        label: "How did you sleep?",
        hint: "Skip if you'd rather not log it.",
      },
      {
        id: "gratitude",
        type: "text",
        label: "What are you grateful for?",
        placeholder: "One thing is plenty.",
      },
      {
        id: "intention",
        type: "text",
        label: "What's the plan for today?",
        hint: "What are you doing, and when? Worth a glance at your calendar.",
        placeholder: "Priorities, rough timing, the shape of the day.",
      },
      {
        id: "energy",
        type: "rating",
        label: "Energy",
        hint: "How's the tank look?",
        max: 5,
      },
    ],
  },
  {
    id: "evening",
    title: "Evening",
    // Tense-agnostic phrasing: the evening wizard renders 2 or 3 prompts
    // depending on whether today's morning intention is available for
    // follow-up (DATA_COLLECTION.md A1). Soft phrasing avoids hard-coding
    // a count that depends on conditional prompts.
    greeting: "Wind-down time. A few quick reflections.",
    prompts: [
      {
        // Only renders when there's a morning intention to follow up on —
        // see SessionPrompt.contextKey. Dropping silently keeps the evening
        // wizard at 3 prompts on days the user didn't journal in the
        // morning (no nudge, no "you skipped").
        id: "intention_followup",
        type: "text",
        label: "How did the plan hold up?",
        hint: "This morning's plan: “{context}”",
        placeholder: "How did it turn out? Honest beats tidy.",
        optional: true,
        contextKey: "morning_intention",
      },
      {
        id: "win",
        type: "text",
        label: "One thing that went well",
        placeholder: "However small.",
      },
      {
        id: "lesson",
        type: "text",
        label: "What did today show you?",
        placeholder: "Optional — something surprising, something confirmed, anything.",
        optional: true,
      },
    ],
  },
  {
    id: "weekly_review",
    title: "Weekly review",
    greeting: "Time to look back on the week.",
    prompts: [
      {
        id: "highlights",
        type: "text",
        label: "What's worth remembering from this week?",
        placeholder: "The moments you'd want to find later.",
      },
      {
        id: "lows",
        type: "text",
        label: "What was hard?",
        placeholder: "Honest, not heavy.",
        optional: true,
      },
      {
        id: "lesson",
        type: "text",
        label: "What did this week teach you?",
        placeholder: "What clicked, or what got clearer.",
        optional: true,
      },
      {
        id: "intention",
        type: "text",
        label: "One intention for the week ahead?",
        placeholder: "Where do you want your attention?",
      },
    ],
  },
];

export function getSession(id: string): Session | undefined {
  return SESSIONS.find((s) => s.id === id);
}

/** Event subject_id for a session entry. */
export function sessionSubjectId(sessionId: Session["id"]): string {
  return `${sessionId}_session`;
}

/** Router path slug. Most ids match the route, but weekly_review → /weekly. */
export function sessionPath(sessionId: Session["id"]): string {
  return sessionId === "weekly_review" ? "weekly" : sessionId;
}

// ---------- Random samples ----------
//
// The schedule + question list moved to @homelab/backend so the api service
// scheduler (services/api/src/lib/notifications/life.ts) and the UI render
// the same prompts. Re-exported under the local names so existing consumers
// (SampleResponseModal, LifeDashboard) don't churn their imports.
export type {
  LifeSampleQuestion as SampleQuestion,
  LifeRandomSamplesConfig as RandomSamplesConfig,
} from "@homelab/backend";
export { RANDOM_SAMPLES } from "@homelab/backend";
