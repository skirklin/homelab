/**
 * Shared defensive parsers for the post-migration `entries` / `labels` JSON
 * columns. The unified event shape (`entries: LifeEntry[]`, `labels: json|null`)
 * is identical across `life_events`, `task_events`, `recipe_events`, and
 * `travel_notes`, so these coercions are shared rather than copy-pasted per
 * backend. They guard real user data: a half-deployed env or a hand-edited /
 * malformed row degrades to a well-typed value instead of crashing the UI.
 */
import type { RecordModel } from "pocketbase";
import type { LifeEntry } from "../types/life";
import type { RawRecord } from "../wrapped-pb/mirror";

/** Defensive parser for the unified `entries` JSON column. */
export function entriesFromRecord(r: RecordModel | RawRecord): LifeEntry[] {
  const x = r as Record<string, unknown>;
  const raw = Array.isArray(x.entries) ? x.entries : [];
  const out: LifeEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.name !== "string") continue;
    if (e.type === "text" && typeof e.value === "string") {
      out.push({ name: e.name, type: "text", value: e.value });
    } else if (e.type === "number" && typeof e.value === "number" && typeof e.unit === "string") {
      const entry: LifeEntry = { name: e.name, type: "number", value: e.value, unit: e.unit };
      if (typeof e.scale === "number") entry.scale = e.scale;
      out.push(entry);
    } else if (e.type === "bool" && typeof e.value === "boolean") {
      out.push({ name: e.name, type: "bool", value: e.value });
    }
  }
  return out;
}

/** Defensive parser for the optional `labels` JSON column (a flat string map). */
export function labelsFromRecord(r: RecordModel | RawRecord): Record<string, string> | undefined {
  const x = r as Record<string, unknown>;
  return x.labels && typeof x.labels === "object" && !Array.isArray(x.labels)
    ? (x.labels as Record<string, string>)
    : undefined;
}

/** Free-form notes serialize as a single `{name:"notes", type:"text"}` entry. */
export function notesEntries(notes?: string): LifeEntry[] {
  const trimmed = notes?.trim();
  return trimmed ? [{ name: "notes", type: "text", value: trimmed }] : [];
}
