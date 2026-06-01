/**
 * Shared timezone helpers for notification scheduling.
 *
 * Both the life-tracker sampler and the travel morning/evening pushes need
 * a way to validate a user-supplied tz string and fall back when it's
 * missing/garbage. Centralising the helper keeps the two crons from
 * silently disagreeing on what counts as a usable timezone.
 */
import { formatInTimeZone } from "date-fns-tz";

/**
 * Return `tz` if it's a non-empty IANA string that date-fns-tz accepts;
 * otherwise return `fallback`. Each caller passes its own preferred default
 * because the two crons intentionally pick different ones:
 *   - travel: "America/Denver" (system owner's tz; the human user is almost
 *     certainly on that clock when their saved tz is missing).
 *   - life:   "UTC" (the random-sample schedule wants deterministic times
 *     across users; locking it to one operator's clock would be wrong for
 *     anyone else on the system).
 * Forcing a single default would change behavior of one of the two crons,
 * so the helper is parameterized rather than picking a winner.
 */
export function safeTz(tz: unknown, fallback: string): string {
  if (typeof tz !== "string" || !tz) return fallback;
  try {
    // Validate by attempting a format — invalid tz throws.
    formatInTimeZone(new Date(), tz, "yyyy");
    return tz;
  } catch {
    return fallback;
  }
}

/**
 * Today's calendar day in Pacific time as `YYYY-MM-DD`.
 *
 * The canonical "what day is it for the human" reduction across the server.
 * The pods run in UTC, so a naive `new Date().toISOString().slice(0,10)` reads
 * a day ahead during the ~5pm–midnight PT window. Anchoring to Pacific keeps
 * day-math (deadline urgency, upkeep due-today, forecast horizons) in sync with
 * what the user sees in the browser. `en-CA` yields the ISO `YYYY-MM-DD` shape.
 */
export function todayPacific(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}
