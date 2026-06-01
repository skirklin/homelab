/**
 * Code-driven manifest for the life app.
 *
 * Every entry is a `life_events` row keyed by `subject_id`. A Trackable is the
 * config for one of those subjects: what to call it, what unit its primary
 * value carries, and what shape its inline log form takes.
 *
 * Aggregation behaviour is derived from `unit` (see `lib/format.ts`'s
 * `aggregationFor`): ratings average, everything else sums. The old explicit
 * `aggregation` field was dropped — it was redundant with `unit` in every
 * existing case.
 *
 * Trackable IDs are persisted in life_events.subject_id. Don't rename them in
 * place — historical events keyed on the old id will fall off the dashboard.
 *
 * The Trackable interface and the TRACKABLES array live in
 * [./trackables.ts](./trackables.ts) so they can be imported from
 * vite.config.ts at config-load time without dragging in @homelab/backend
 * (whose TS sources the vite-config loader can't transpile). This file
 * re-exports them and adds the runtime bits that *do* depend on the backend
 * (SessionPrompt/Session, RANDOM_SAMPLES re-export).
 */
import type { SampleSchedule, LifeLog } from "@homelab/backend";

export type { SampleSchedule, LifeLog };
export { TRACKABLES, GROUP_ORDER, getTrackable, type Trackable } from "./trackables";

// ---------- Sessions ----------

export interface SessionPrompt {
  /** Key in the resulting event's entries. Don't rename without a migration. */
  id: string;
  type: "text" | "rating" | "number" | "checkbox";
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
        id: "gratitude",
        type: "text",
        label: "What are you grateful for?",
        placeholder: "One thing is plenty.",
      },
      {
        id: "intention",
        type: "text",
        label: "One thing that matters today",
        placeholder: "What feels worth your attention.",
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
        label: "How did that go?",
        hint: "This morning, what mattered to you was: “{context}”",
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
