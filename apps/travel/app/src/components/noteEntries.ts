/**
 * Pure helpers for the per-user travel-notes thread (Phase 4).
 *
 * A `TravelNote` carries a `LifeEntry[]` whose shape depends on the subject:
 *   - activity → [{name:"verdict",type:"text"}, {name:"notes",type:"text"}]
 *   - day      → [{name:"text"}, {name:"highlight"}, {name:"mood",type:"number",unit:"rating"}]
 *   - trip     → [{name:"notes",type:"text"}]
 *
 * These helpers encode/decode that shape and select notes for a subject. They
 * live apart from the React component so they can be unit-tested without a DOM.
 */
import type { TravelNote, ActivityVerdict, LifeEntry } from "../types";

export type SubjectType = "activity" | "day" | "trip";

/** A day note's editable fields, decoded from its entries. */
export interface DayFields {
  text: string;
  highlight: string;
  mood: number | null;
}

const VERDICTS = new Set<ActivityVerdict>(["loved", "liked", "meh", "skip"]);

function textEntry(entries: LifeEntry[], name: string): string {
  for (const e of entries) {
    if (e.name === name && e.type === "text") return e.value;
  }
  return "";
}

function numberEntry(entries: LifeEntry[], name: string): number | null {
  for (const e of entries) {
    if (e.name === name && e.type === "number") return e.value;
  }
  return null;
}

/**
 * Filter the log-scoped notes mirror down to one subject. Notes are already
 * log-scoped in state (the security invariant from Phase 3 #9 — we never query
 * by subject_id across logs), so this is a pure in-memory filter.
 *
 * Newest-first, with a `created || now` fallback so an optimistically-added
 * note (no server `created` yet) sorts to the top instead of wobbling.
 */
export function selectNotes(
  notes: Iterable<TravelNote>,
  subjectType: SubjectType,
  subjectId: string,
): TravelNote[] {
  const nowIso = new Date().toISOString();
  const out: TravelNote[] = [];
  for (const n of notes) {
    if (n.subjectType === subjectType && n.subjectId === subjectId) out.push(n);
  }
  return out.sort((a, b) => {
    const ca = a.created || nowIso;
    const cb = b.created || nowIso;
    return ca < cb ? 1 : ca > cb ? -1 : 0;
  });
}

/** The current user's own note for a subject, if any (at most one per user). */
export function ownNote(notes: TravelNote[], userId: string | undefined): TravelNote | undefined {
  if (!userId) return undefined;
  return notes.find((n) => n.createdBy === userId);
}

/** `created_by === ""` → a backfilled/imported row whose author is unknown. */
export function isImported(note: TravelNote): boolean {
  return note.createdBy === "";
}

// ── activity ─────────────────────────────────────────────────────

/** Decode a caller's verdict from their activity note (undefined if absent). */
export function verdictOf(note: TravelNote | undefined): ActivityVerdict | undefined {
  if (!note) return undefined;
  const v = textEntry(note.entries, "verdict");
  return VERDICTS.has(v as ActivityVerdict) ? (v as ActivityVerdict) : undefined;
}

export function activityNotesText(note: TravelNote | undefined): string {
  return note ? textEntry(note.entries, "notes") : "";
}

/** Build the entries[] for an activity note. Only non-empty values are kept. */
export function activityEntries(verdict: ActivityVerdict | null, notes: string): LifeEntry[] {
  const out: LifeEntry[] = [];
  if (verdict) out.push({ name: "verdict", type: "text", value: verdict });
  const t = notes.trim();
  if (t) out.push({ name: "notes", type: "text", value: t });
  return out;
}

// ── day ──────────────────────────────────────────────────────────

export function dayFieldsOf(note: TravelNote | undefined): DayFields {
  if (!note) return { text: "", highlight: "", mood: null };
  return {
    text: textEntry(note.entries, "text"),
    highlight: textEntry(note.entries, "highlight"),
    mood: numberEntry(note.entries, "mood"),
  };
}

export function dayEntries(fields: DayFields): LifeEntry[] {
  const out: LifeEntry[] = [];
  const text = fields.text.trim();
  const highlight = fields.highlight.trim();
  if (text) out.push({ name: "text", type: "text", value: text });
  if (highlight) out.push({ name: "highlight", type: "text", value: highlight });
  if (fields.mood != null) {
    out.push({ name: "mood", type: "number", value: fields.mood, unit: "rating", scale: 5 });
  }
  return out;
}

/** `"${tripId}:${date}"` — split on the FIRST colon to recover the parts. */
export function daySubjectId(tripId: string, date: string): string {
  return `${tripId}:${date}`;
}

// ── trip ─────────────────────────────────────────────────────────

export function tripNotesText(note: TravelNote | undefined): string {
  return note ? textEntry(note.entries, "notes") : "";
}

export function tripEntries(notes: string): LifeEntry[] {
  const t = notes.trim();
  return t ? [{ name: "notes", type: "text", value: t }] : [];
}

/** True when a note carries no meaningful content (all fields empty). */
export function isEmptyEntries(entries: LifeEntry[]): boolean {
  return entries.length === 0;
}
