/**
 * The user's IANA timezone — the single source for "which day/week does an
 * event belong to" math across the life app (Log cards, the calendar, goals,
 * backfill). It must match what the goal evaluator runs with server-side: the
 * log owner's saved `users.timezone`. The backend-provider keeps that field in
 * sync with the browser's `Intl` zone, so reading the auth record's timezone
 * (with an `Intl` fallback for the brief window before the first sync) gives a
 * value that agrees with the server.
 *
 * Tz is stable within a session, so this is a plain read — no subscription. A
 * mid-session zone change (the user travels) takes effect on the next reload,
 * which is when the backend-provider re-syncs the field anyway.
 */
import { getBackend } from "@kirkl/shared";

export function userTz(): string {
  // getBackend() throws before initializeBackend() (e.g. in unit tests); a
  // missing/blank saved tz also falls through to the browser zone.
  try {
    const recordTz = getBackend().authStore.record?.timezone;
    if (typeof recordTz === "string" && recordTz) return recordTz;
  } catch {
    // backend not initialized — use the browser zone
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Hook form — identical value, for components that prefer a hook call. */
export function useUserTz(): string {
  return userTz();
}
