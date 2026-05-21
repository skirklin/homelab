/**
 * Code-driven manifest for the life app.
 *
 * Edit this file to change widgets, sessions, prompts, sampling, or migrations.
 * No UI editor — solo-user app, fast deploy loop. Mobile JSON editing was a bad
 * idea.
 *
 * Widget IDs are persisted in life_events.subject_id. Don't rename them in
 * place — add a MIGRATIONS entry instead so historical entries still resolve.
 */
import { RANDOM_SAMPLES } from "@homelab/backend";
import type { LifeManifest, EntryMigration } from "./types";

// Re-export so existing consumers (`MANIFEST.randomSamples` callers, etc.)
// keep working unchanged. The single source of truth lives in
// `@homelab/backend` so the api scheduler can label push notifications with
// the same questions the UI prompts for.
export { RANDOM_SAMPLES };
export type { LifeRandomSamplesConfig, LifeSampleQuestion } from "@homelab/backend";

export interface SessionPrompt {
  /** Key in the resulting event.data object. Don't rename without a migration. */
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
}

export interface Session {
  /** Route slug — `/morning`, `/evening`, etc. Also the event subject_id is `<id>_session`. */
  id: "morning" | "evening";
  title: string;
  /** One-line greeting shown at the top of the wizard. */
  greeting: string;
  prompts: SessionPrompt[];
}

export const MANIFEST: LifeManifest = {
  widgets: [
    {
      id: "medical",
      type: "counter-group",
      label: "medical",
      counters: [
        { id: "vyvanse", label: "Vyvanse" },
        { id: "vitamins", label: "Vitamins" },
        { id: "ibuprofin", label: "Ibuprofin" },
      ],
    },
    {
      id: "consumables",
      type: "counter-group",
      label: "Consumables",
      counters: [
        { id: "edibles", label: "Edibles" },
        { id: "alcohol", label: "Alcohol" },
        { id: "coffee", label: "Coffee" },
      ],
    },
    {
      id: "bio",
      type: "counter-group",
      label: "bio",
      counters: [
        { id: "poop", label: "Poop" },
        { id: "wank", label: "Wank" },
        { id: "sex", label: "Boink" },
      ],
    },
    { id: "floss", type: "counter", label: "Floss" },
    {
      id: "sleep",
      type: "combo",
      label: "Sleep",
      fields: [
        { id: "hours", type: "number", label: "Hours", min: 0, max: 24 },
        { id: "quality", type: "rating", label: "Quality", max: 5 },
      ],
    },
    {
      id: "exercise",
      type: "combo",
      label: "Exercise",
      fields: [
        { id: "hours", type: "number", label: "Hours", min: 0, max: 24 },
        { id: "intensity", type: "rating", label: "Intensity", max: 5 },
      ],
    },
    {
      id: "symptoms",
      type: "combo",
      label: "Symptoms",
      fields: [
        { id: "left-hand-twitch", type: "rating", label: "Left hand twitch", max: 5 },
        { id: "phantom-pain", type: "rating", label: "Phantom pain", max: 5 },
      ],
    },
    {
      id: "work",
      type: "combo",
      label: "Work",
      fields: [
        { id: "hours", type: "number", label: "Hours", min: 0, max: 24 },
        { id: "quality", type: "rating", label: "Quality", max: 5 },
      ],
    },
  ],
  randomSamples: RANDOM_SAMPLES,
};

export const MIGRATIONS: EntryMigration[] = [
  { from: "left-hand-twitch", to: "symptoms", field: "left-hand-twitch" },
];

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
        label: "One thing you want to do well today",
        placeholder: "Keep it small and concrete.",
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
    greeting: "Wind-down time. Three quick reflections.",
    prompts: [
      {
        id: "win",
        type: "text",
        label: "One thing that went well",
        placeholder: "However small.",
      },
      {
        id: "lesson",
        type: "text",
        label: "Anything to do differently tomorrow?",
        placeholder: "Optional — skip if nothing comes to mind.",
        optional: true,
      },
      {
        id: "mood",
        type: "rating",
        label: "How are you feeling now?",
        max: 5,
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
