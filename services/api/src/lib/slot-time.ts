/**
 * Slot start-time normalization for the itinerary write path.
 *
 * `ActivitySlot.startTime` is stored as canonical 24-hour `"HH:MM"`, local
 * wall-clock at the activity's location. Writes accept human input (`"5:30 PM"`,
 * `"5pm"`) and normalize to canonical form here. This mirrors `parseSlotTime` /
 * `canonicalSlotTime` in `apps/travel/app/src/time.ts` — small duplication kept
 * rather than coupling the API to the app package.
 */

/** Minutes since local midnight, or null for empty/unparseable input. */
export function parseSlotTime(s?: string | null): number | null {
  if (!s) return null;
  const str = s.trim();
  if (!str) return null;
  const m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    const isPm = m[3].toLowerCase() === "p";
    if (h === 12) h = 0;
    if (isPm) h += 12;
    return h * 60 + min;
  }
  const h24 = str.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const h = Number(h24[1]);
    const min = Number(h24[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  return null;
}

/**
 * Normalize any accepted start-time input to canonical 24-hour `"HH:MM"`.
 * Returns undefined for empty/unparseable input. Idempotent.
 */
export function canonicalSlotTime(s?: string | null): string | undefined {
  const mins = parseSlotTime(s);
  if (mins == null) return undefined;
  const h = Math.floor(mins / 60);
  const min = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
