/**
 * IndexedDB persistence for cached server snapshots.
 *
 * Mirrors persistence.ts (the mutation queue) but for read state: every
 * server snapshot the mutation queue applies (bootstrap seed, SSE event,
 * resync, write-ack) is mirrored into IDB so the NEXT cold load can paint
 * cached data instantly (stale-while-revalidate) instead of blocking on
 * serial network round-trips behind the SW's NetworkFirst timeout.
 *
 * Scoping: rows are keyed `${user}::${collection}::${id}` and carry a `user`
 * field indexed for scoped hydration. A session authed as user B must never
 * read user A's cached rows (and sign-out clears the store outright).
 *
 * All writes try/catch-swallow: persistence is non-fatal, the in-memory
 * queue is always the source of truth at runtime.
 */
import { getDb, SNAPSHOTS_STORE } from "./idb";
import type { RawRecord } from "./queue";

export interface PersistedSnapshot {
  /** `${user}::${collection}::${id}` — the IDB primary key. */
  key: string;
  /** Auth record id this snapshot belongs to (indexed for scoped reads). */
  user: string;
  collection: string;
  id: string;
  record: RawRecord;
  /** ms epoch of the last write — used by age-based eviction. */
  updatedAt: number;
}

export function snapshotKey(user: string, collection: string, id: string): string {
  return `${user}::${collection}::${id}`;
}

export async function persistSnapshots(rows: PersistedSnapshot[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const db = await getDb();
    const tx = db.transaction(SNAPSHOTS_STORE, "readwrite");
    for (const row of rows) tx.store.put(row);
    await tx.done;
  } catch {
    // Persistence failures are non-fatal — the in-memory queue still works.
  }
}

export async function deleteSnapshots(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    const db = await getDb();
    const tx = db.transaction(SNAPSHOTS_STORE, "readwrite");
    for (const key of keys) tx.store.delete(key);
    await tx.done;
  } catch {
    // ignore
  }
}

export async function loadSnapshotsForUser(user: string): Promise<PersistedSnapshot[]> {
  if (!user) return [];
  try {
    const db = await getDb();
    return (await db.getAllFromIndex(SNAPSHOTS_STORE, "user", user)) as PersistedSnapshot[];
  } catch {
    return [];
  }
}

export async function clearAllSnapshots(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(SNAPSHOTS_STORE);
  } catch {
    // ignore
  }
}

/**
 * Age-based eviction. Called from hydrate so the cache doesn't grow
 * unbounded across sessions. KISS: a simple cutoff sweep, no LRU — the
 * working set is small and a stale row just costs one revalidation fetch.
 */
export async function pruneSnapshotsOlderThan(cutoffMs: number): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction(SNAPSHOTS_STORE, "readwrite");
    const all = (await tx.store.getAll()) as PersistedSnapshot[];
    for (const row of all) {
      if (row.updatedAt < cutoffMs) tx.store.delete(row.key);
    }
    await tx.done;
  } catch {
    // ignore
  }
}
