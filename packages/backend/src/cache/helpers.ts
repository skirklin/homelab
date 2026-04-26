/**
 * Helpers for wrapping backend methods with offline cache.
 *
 * Two patterns:
 *  - `cachedRead`: stale-while-revalidate for one-shot Promise reads.
 *    Returns fresh data when online; falls back to cache on failure.
 *  - `hydrateThen`: feeds cached data into a subscription's callbacks
 *    immediately, then lets live updates overlay it.
 */
import { cacheGet, cacheSet } from "./storage";

/** Return fresh data, caching it. On error, fall back to last cached. */
export async function cachedRead<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  try {
    const fresh = await fetcher();
    await cacheSet(key, fresh);
    return fresh;
  } catch (err) {
    const cached = await cacheGet<T>(key);
    if (cached !== undefined) return cached;
    throw err;
  }
}

/**
 * Wrap a per-key callback so every call also writes the value to cache.
 * Use inside subscription methods: pass `cached(key, handlers.onItems)` instead
 * of `handlers.onItems` so live PB snapshots get persisted automatically.
 */
export function cached<T>(key: string, cb: (value: T) => void): (value: T) => void {
  return (value: T) => {
    void cacheSet(key, value);
    cb(value);
  };
}

/**
 * Read a cached value (if any) and pass it to the callback synchronously
 * via microtask. Returns a function that flips a flag — call it once a real
 * value has arrived from the network so we don't clobber it with stale data.
 */
export function hydrateOne<T>(key: string, cb: (value: T) => void): { live: () => void } {
  let liveReceived = false;
  void (async () => {
    const value = await cacheGet<T>(key);
    if (!liveReceived && value !== undefined) cb(value);
  })();
  return {
    live: () => {
      liveReceived = true;
    },
  };
}
