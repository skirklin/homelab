/**
 * Slot start-time helpers.
 *
 * `ActivitySlot.startTime` is stored as canonical 24-hour `"HH:MM"`, local
 * wall-clock at the activity's own location (NOT a fixed trip timezone — a day
 * may span zones, and each slot's time is matched against that activity's own
 * coordinate for weather). These helpers parse/format/normalize that value and
 * tolerate the legacy free-form strings (`"5:30 PM"`, `"5pm"`) that predate the
 * canonical form, so reads stay correct before the backfill runs.
 */

/**
 * Parse a slot start-time to minutes since local midnight. Accepts canonical
 * 24-hour (`"17:30"`, `"09:00"`) and legacy human forms (`"5:30 PM"`, `"5 PM"`,
 * `"5pm"`, `"5:30pm"`). Returns null for empty/unparseable input.
 */
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
    if (h === 12) h = 0; // 12am -> 0, 12pm -> 12 (after +12 below)
    if (isPm) h += 12;
    return h * 60 + min;
  }
  // 24-hour "HH:MM" (or "H:MM").
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
 * Normalize any accepted input to canonical 24-hour `"HH:MM"`. Returns
 * undefined for empty/unparseable input (so callers can drop the field).
 * Idempotent: a value already in `"HH:MM"` round-trips unchanged.
 */
export function canonicalSlotTime(s?: string | null): string | undefined {
  const mins = parseSlotTime(s);
  if (mins == null) return undefined;
  const h = Math.floor(mins / 60);
  const min = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Render a slot start-time (canonical or legacy) as a human 12-hour string
 * (`"5:30 PM"`, `"9:00 AM"`). Empty/unparseable → "".
 */
export function formatSlotTime(s?: string | null): string {
  const mins = parseSlotTime(s);
  if (mins == null) return "";
  let h = Math.floor(mins / 60);
  const min = mins % 60;
  const meridiem = h < 12 ? "AM" : "PM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(min).padStart(2, "0")} ${meridiem}`;
}
