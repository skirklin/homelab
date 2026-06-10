/**
 * Shared timezone helpers for notification scheduling.
 *
 * Both the life-tracker sampler and the travel morning/evening pushes need
 * a way to validate a user-supplied tz string and fall back when it's
 * missing/garbage. Centralising the helper keeps the two crons from
 * silently disagreeing on what counts as a usable timezone.
 */
import { formatInTimeZone } from "date-fns-tz";
import type PocketBase from "pocketbase";

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

/**
 * Build a per-run resolver from user id → IANA timezone string.
 *
 * Used by the notification crons (travel tick, life reminders, life sampling)
 * which each iterate many owners and often hit the same user repeatedly. The
 * returned closure memoizes per run in a local `Map` — deliberately NOT a
 * module-level cache: these run in a long-lived scheduler process, so a
 * persistent cache would serve a stale tz after a user changes timezone.
 *
 * `fallbackTz` is returned for an empty `userId`, an unreadable user record,
 * or a missing/garbage `timezone` field (via `safeTz`). Each caller supplies
 * the fallback its cron wants (travel: the operator's tz; life: UTC / the
 * system config tz) — see `safeTz`'s note on why this is parameterized.
 */
export function makeUserTzResolver(
  pb: PocketBase,
  fallbackTz: string,
): (userId: string) => Promise<string> {
  const cache = new Map<string, string>();
  return async (userId: string): Promise<string> => {
    if (!userId) return fallbackTz;
    const hit = cache.get(userId);
    if (hit) return hit;
    let tz: string;
    try {
      const u = await pb.collection("users").getOne(userId, { $autoCancel: false });
      tz = safeTz(u.timezone, fallbackTz);
    } catch {
      tz = fallbackTz;
    }
    cache.set(userId, tz);
    return tz;
  };
}
