/**
 * Retry helper for transient PocketBase/SQLite errors.
 *
 * SQLite can return "database is locked" or "SQLITE_BUSY" under write
 * contention. PocketBase surfaces these as 500 ClientResponseError.
 * This helper retries with exponential backoff for those specific errors.
 */

const BUSY_RE = /busy|locked|SQLITE_BUSY|SQLITE_LOCKED/i;
const DELAYS_MS = [25, 50, 100, 200, 400, 800];

function isBusyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; message?: string; data?: { message?: string } };
  if (e.status && e.status !== 500 && e.status !== 503) return false;
  const msg = e.message || e.data?.message || "";
  return BUSY_RE.test(msg) || e.status === 503;
}

/** Run `fn` up to DELAYS_MS.length + 1 times, retrying only on SQLite busy/locked. */
export async function retryOnBusy<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === DELAYS_MS.length || !isBusyError(err)) throw err;
      await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}
