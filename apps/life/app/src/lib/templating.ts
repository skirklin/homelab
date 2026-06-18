/**
 * Pure templating resolver for View prompt/hint/banner text.
 *
 * A vocab row rendered inside a View may carry `{token}` placeholders in its
 * `prompt`/`hint`, and a banner item carries them in its `text`. Each token is
 * backed by a `TemplateRef` that pulls the user's own most-recent value for
 * `fromTrackable` within a lookback window and substitutes it.
 *
 * This REPLACES the old bespoke resolvers (`findMorningIntention` /
 * `findCurrentWeekIntention` / `contextKey`) with one data-driven function.
 *
 * DROP-IF-ABSENT (load-bearing): if ANY ref required by `text` fails to resolve
 * (no event in window, or the chosen entry is empty), `resolveTemplate` returns
 * `null`. The caller then DROPS the step/banner entirely — never renders it
 * blank or with a "you skipped this" nudge. This preserves today's no-nudge
 * behavior (the evening intention-follow-up simply doesn't appear on days with
 * no morning intention).
 *
 * WINDOW SEMANTICS (owner-local, via the shared tz-aware helpers):
 *   - `within: "day"`  → the owner-local day containing `now` (today).
 *   - `within: "week"` → the last 7 owner-local days (now − 7d … now). A
 *     rolling 7-day lookback, NOT the Sunday-start calendar week — this is the
 *     "what did you intend this week" recency window, so a Tuesday morning
 *     still surfaces last Sunday's weekly intention.
 *
 * Pure: no React, no I/O, no clock read beyond the passed `now`.
 */
import type { LifeEvent, LifeEntry, TemplateRef } from "@homelab/backend";
import { startOfDay, endOfDay } from "@homelab/backend";

/** A token → its resolved replacement string (or unresolved). */
interface Resolution {
  value: string | null;
}

/** Pull the display string for a ref out of an event's entries[]. */
function entryValue(event: LifeEvent, ref: TemplateRef): string | null {
  const { entries } = event;
  let chosen: LifeEntry | undefined;
  if (ref.entry) {
    chosen = entries.find((e) => e.name === ref.entry);
  } else {
    // Default per the source shape: prefer the first text entry (noted/journal
    // prompts), else the first number entry. Name-agnostic so legacy entry
    // names resolve identically to canonical ones.
    chosen = entries.find((e) => e.type === "text") ?? entries.find((e) => e.type === "number");
  }
  if (!chosen) return null;
  const raw = typeof chosen.value === "string" ? chosen.value : String(chosen.value);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve a single ref to its substitution string, or null when no qualifying
 * event exists in the window (or its chosen entry is empty).
 */
function resolveRef(ref: TemplateRef, events: LifeEvent[], now: Date, tz: string): Resolution {
  let lo: number;
  let hi: number;
  if (ref.within === "day") {
    lo = startOfDay(now, tz).getTime();
    hi = endOfDay(now, tz).getTime();
  } else {
    // Rolling 7-day window ending at `now`.
    hi = now.getTime();
    lo = hi - 7 * 24 * 60 * 60 * 1000;
  }

  // Most-recent qualifying event for this trackable within the window.
  let best: LifeEvent | null = null;
  for (const ev of events) {
    if (ev.subjectId !== ref.fromTrackable) continue;
    const t = ev.timestamp.getTime();
    if (t < lo || t > hi) continue;
    if (!best || t > best.timestamp.getTime()) best = ev;
  }
  if (!best) return { value: null };
  return { value: entryValue(best, ref) };
}

/**
 * Substitute every `{token}` in `text` using `refs` against the user's
 * `events`. Returns the filled string, or `null` if any token referenced by the
 * text has a ref that fails to resolve (the caller drops the step/banner).
 *
 * A `{token}` with NO matching ref in `refs` is left intact (it is not a
 * template hole this resolver owns) and does not trigger a drop — only refs
 * whose tokens actually appear in the text are required.
 */
export function resolveTemplate(
  text: string,
  refs: TemplateRef[] | undefined,
  events: LifeEvent[],
  tz: string,
  now: Date = new Date(),
): string | null {
  if (!refs || refs.length === 0) return text;

  // Resolve only the refs whose token actually appears in the text.
  const cache = new Map<string, Resolution>();
  for (const ref of refs) {
    if (!text.includes(`{${ref.token}}`)) continue;
    if (cache.has(ref.token)) continue;
    const res = resolveRef(ref, events, now, tz);
    if (res.value === null) return null; // a required token failed → drop.
    cache.set(ref.token, res);
  }

  let out = text;
  for (const [token, res] of cache) {
    // res.value is non-null here (we returned early on null).
    out = out.split(`{${token}}`).join(res.value as string);
  }
  return out;
}
