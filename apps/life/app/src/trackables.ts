/**
 * Trackable definitions, split out from manifest.ts so vite.config.ts can
 * import them at config-load time without dragging in @homelab/backend (whose
 * TS sources aren't transpiled by the vite-config loader). The runtime
 * surface remains `manifest.ts` — this file is an internal data module that
 * manifest re-exports.
 */

/**
 * One thing the user wants to track. Solo-user — edit this file to add or
 * remove items. No DB-driven config.
 */
export interface Trackable {
  /** Becomes subject_id on events. Don't rename without considering history. */
  id: string;
  label: string;
  /**
   * Canonical storage unit for the trackable's primary numeric entry.
   *   "min"     durations (sleep, exercise, focus)
   *   "mg"      doses
   *   "oz"      volumes
   *   "drinks"  count of alcoholic drinks
   *   "ct"      count of discrete things
   *   "rating"  1..5 rating
   *
   * Hours-as-input duration trackables (defaultValue >= 60) accept hours in
   * the inline form and convert to minutes on write.
   */
  unit: "min" | "mg" | "ct" | "drinks" | "oz" | "rating" | string;
  /** Visual grouping on the dashboard. Trackables without a group are rendered as standalones. */
  group?: string;
  /** If set, the log form shows a category picker; written into `labels.category`. */
  categories?: string[];
  /** If true, the log form shows a 1-5 intensity picker stored as a rating entry. */
  hasIntensity?: boolean;
  /** Pre-filled in the log form. Stored in the trackable's canonical unit. */
  defaultValue?: number;
  /** If true, the log form shows a notes textarea (stored as a text entry). */
  hasNotes?: boolean;
  /**
   * Optional one-tap shortcuts surfaced on the collapsed card. Tapping a chip
   * writes a single-entry event with just the primary numeric value — no
   * category, intensity, or notes (the point is a fast log; the full form is
   * still one tap away on the +).
   *
   * `value` is in the trackable's canonical storage unit (minutes for sleep,
   * mg for edibles, etc.), matching `defaultValue`. `label` is whatever reads
   * cleanly on a chip ("8h", "2.5mg").
   *
   * Presets also feed the PWA's web-manifest `shortcuts[]` so the app icon's
   * long-press menu can log the same values without opening the app.
   */
  presets?: Array<{ label: string; value: number }>;
  /**
   * Per-trackable opt-out from the dashboard grid. Events still write/read
   * fine for any code that references the id — this just hides the card so
   * historical data aggregates correctly if the flag is later removed.
   */
  hidden?: boolean;
}

export const TRACKABLES: Trackable[] = [
  // medical
  { id: "vyvanse",       label: "Vyvanse",       unit: "mg",     group: "medical",     defaultValue: 30 },
  { id: "vitamins",      label: "Vitamins",      unit: "ct",     group: "medical",     defaultValue: 1,   hidden: true },
  { id: "ibuprofin",     label: "Ibuprofin",     unit: "mg",     group: "medical",     defaultValue: 400, hidden: true },

  // consumables
  { id: "edibles",       label: "Edibles",       unit: "mg",     group: "consumables", defaultValue: 5,
    presets: [
      { label: "2.5mg", value: 2.5 },
      { label: "5mg",   value: 5 },
      { label: "10mg",  value: 10 },
    ] },
  { id: "alcohol",       label: "Alcohol",       unit: "drinks", group: "consumables", defaultValue: 1 },
  { id: "coffee",        label: "Coffee",        unit: "oz",     group: "consumables", defaultValue: 8 },

  // bio
  { id: "poop",          label: "Poop",          unit: "ct",     group: "bio",         defaultValue: 1 },
  { id: "wank",          label: "Wank",          unit: "ct",     group: "bio",         defaultValue: 1 },
  { id: "sex",           label: "Boink",         unit: "ct",     group: "bio",         defaultValue: 1 },

  // standalone
  { id: "floss",         label: "Floss",         unit: "ct",     defaultValue: 1 },

  // time-based — defaultValue is in minutes; the inline form auto-switches to
  // hours input when defaultValue >= 60 and converts back on submit.
  // sleep_quality sits adjacent to sleep so the two render side-by-side.
  { id: "sleep",         label: "Sleep",         unit: "min",    group: "time-based", defaultValue: 480, hasNotes: true,
    presets: [
      { label: "7h", value: 420 },
      { label: "8h", value: 480 },
      { label: "9h", value: 540 },
    ] },
  { id: "sleep_quality", label: "Sleep quality", unit: "rating", group: "time-based" },
  { id: "exercise",      label: "Exercise",      unit: "min",    group: "time-based",
    categories: ["walk", "run", "bike", "PT", "lift", "yoga", "other"],
    hasIntensity: true, defaultValue: 30 },
  { id: "focus",         label: "Focus",         unit: "min",    group: "time-based",
    categories: ["chinese", "coding", "learning", "trip planning"], defaultValue: 25 },

  // rating-shaped — hidden while random sampling is paused. No events being
  // generated, so the cards just sit empty on the grid. Un-hide if sampling
  // resumes; entries persist either way.
  { id: "mood",          label: "Mood",          unit: "rating", group: "ratings", hidden: true },
  { id: "content",       label: "Content",       unit: "rating", group: "ratings", hidden: true },
];

export function getTrackable(id: string): Trackable | undefined {
  return TRACKABLES.find((t) => t.id === id);
}

/**
 * Group order on the dashboard. Items not in this list fall through to the
 * "standalone" bucket. Tweak freely — solo app.
 */
export const GROUP_ORDER = ["medical", "consumables", "bio", "time-based"] as const;
