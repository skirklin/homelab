/**
 * Code-driven manifest for the life app.
 *
 * Every entry is a `life_events` row keyed by `subject_id`. A Trackable is the
 * config for one of those subjects: what to call it, what unit it carries,
 * how to aggregate today's values, and what optional shape its `data` may
 * take (`category`, `intensity`, `notes`).
 *
 * Trackable IDs are persisted in life_events.subject_id. Don't rename them in
 * place — historical events will fall through to the legacy adapter and
 * surface as unknown.
 */
import type { SampleSchedule, LifeLog } from "@homelab/backend";

export type { SampleSchedule, LifeLog };

/**
 * One thing the user wants to track. Solo-user — edit this file to add or
 * remove items. No DB-driven config.
 */
export interface Trackable {
  /** Becomes subject_id on events. Don't rename without considering history. */
  id: string;
  label: string;
  /** Display unit. "rating" is special — the value field becomes a 1-5 picker. */
  unit: "min" | "mg" | "ct" | "drinks" | "oz" | "rating" | string;
  aggregation: "sum" | "avg" | "last";
  /** Visual grouping on the dashboard. Trackables without a group are rendered as standalones. */
  group?: string;
  /** If set, the log form shows a category picker. */
  categories?: string[];
  /** If true, the log form shows a 1-5 intensity picker. */
  hasIntensity?: boolean;
  /** Pre-filled in the log form. */
  defaultValue?: number;
  /** If true, the log form shows a notes textarea. */
  hasNotes?: boolean;
  /** Reserved for future timer mode. */
  supportsEndTime?: boolean;
}

export const TRACKABLES: Trackable[] = [
  // medical
  { id: "vyvanse",       label: "Vyvanse",       unit: "mg",     aggregation: "sum", group: "medical",     defaultValue: 30 },
  { id: "vitamins",      label: "Vitamins",      unit: "ct",     aggregation: "sum", group: "medical",     defaultValue: 1 },
  { id: "ibuprofin",     label: "Ibuprofin",     unit: "mg",     aggregation: "sum", group: "medical",     defaultValue: 400 },

  // consumables
  { id: "edibles",       label: "Edibles",       unit: "mg",     aggregation: "sum", group: "consumables", defaultValue: 5 },
  { id: "alcohol",       label: "Alcohol",       unit: "drinks", aggregation: "sum", group: "consumables", defaultValue: 1 },
  { id: "coffee",        label: "Coffee",        unit: "oz",     aggregation: "sum", group: "consumables", defaultValue: 8 },

  // bio
  { id: "poop",          label: "Poop",          unit: "ct",     aggregation: "sum", group: "bio",         defaultValue: 1 },
  { id: "wank",          label: "Wank",          unit: "ct",     aggregation: "sum", group: "bio",         defaultValue: 1 },
  { id: "sex",           label: "Boink",         unit: "ct",     aggregation: "sum", group: "bio",         defaultValue: 1 },

  // standalone
  { id: "floss",         label: "Floss",         unit: "ct",     aggregation: "sum", defaultValue: 1 },

  // time-based
  { id: "sleep",         label: "Sleep",         unit: "min",    aggregation: "sum", group: "time-based", defaultValue: 480, hasNotes: true },
  { id: "exercise",      label: "Exercise",      unit: "min",    aggregation: "sum", group: "time-based",
    categories: ["walk", "run", "bike", "PT", "lift", "yoga", "other"],
    hasIntensity: true, defaultValue: 30 },
  { id: "focus",         label: "Focus",         unit: "min",    aggregation: "sum", group: "time-based",
    categories: ["chinese", "coding", "learning", "trip planning"], defaultValue: 25 },

  // rating-shaped
  { id: "mood",          label: "Mood",          unit: "rating", aggregation: "avg", group: "ratings" },
  { id: "content",       label: "Content",       unit: "rating", aggregation: "avg", group: "ratings" },
  { id: "sleep_quality", label: "Sleep quality", unit: "rating", aggregation: "avg", group: "ratings" },
];

export function getTrackable(id: string): Trackable | undefined {
  return TRACKABLES.find((t) => t.id === id);
}

/**
 * Group order on the dashboard. Items not in this list fall through to the
 * "standalone" bucket. Tweak freely — solo app.
 */
export const GROUP_ORDER = ["medical", "consumables", "bio", "time-based", "ratings"] as const;

// ---------- Sessions ----------

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
  {
    id: "weekly_review",
    title: "Weekly review",
    greeting: "Time to look back on the week.",
    prompts: [
      {
        id: "highlights",
        type: "text",
        label: "What were the highlights of the week?",
        placeholder: "Pick a few that stood out.",
      },
      {
        id: "lows",
        type: "text",
        label: "What went poorly or felt off?",
        placeholder: "Honest, not heavy.",
        optional: true,
      },
      {
        id: "lesson",
        type: "text",
        label: "One thing to do differently next week?",
        placeholder: "Concrete and small beats grand.",
        optional: true,
      },
      {
        id: "intention",
        type: "text",
        label: "One intention for the week ahead?",
        placeholder: "Where do you want your attention?",
      },
      {
        id: "mood_rating",
        type: "rating",
        label: "Overall how do you feel about this week?",
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

// ---------- Random samples ----------

export interface SampleQuestion {
  /** Becomes the subject_id of the resulting event. Pick from TRACKABLES so
   *  the response flows back into the same series as manual entries. */
  trackableId: string;
  /** Override label shown in the modal. Defaults to the trackable's label. */
  label?: string;
}

export interface RandomSamplesConfig {
  enabled: boolean;
  timesPerDay: number;
  activeHours: [number, number]; // [startHour, endHour] in 24h format
  timezone?: string; // IANA timezone
  questions: SampleQuestion[];
}

export const RANDOM_SAMPLES: RandomSamplesConfig = {
  enabled: true,
  timesPerDay: 3,
  activeHours: [9, 22],
  timezone: "America/Los_Angeles",
  questions: [
    { trackableId: "mood",    label: "How happy do you feel?" },
    { trackableId: "content", label: "How anxious/content are you feeling?" },
  ],
};
