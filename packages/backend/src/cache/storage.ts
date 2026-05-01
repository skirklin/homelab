/**
 * Lightweight IndexedDB cache + mutation-queue persistence.
 *
 * Two object stores in one DB:
 * - `kv`: key/value snapshots for offline reads. Keys like `travel:trips:<logId>`.
 * - `mutations`: optimistic-write queue, keyed by mutation id. Drained on ack/reject.
 */
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "kirkl-cache";
const DB_VERSION = 2;
const STORE = "kv";
export const MUTATIONS_STORE = "mutations";

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDb(): Promise<IDBPDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        if (!db.objectStoreNames.contains(MUTATIONS_STORE)) {
          db.createObjectStore(MUTATIONS_STORE, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await getDb();
    return (await db.get(STORE, key)) as T | undefined;
  } catch {
    return undefined;
  }
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  try {
    const db = await getDb();
    await db.put(STORE, value, key);
  } catch {
    // Storage failures are non-fatal — we just skip caching this update.
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(STORE, key);
  } catch {
    // ignore
  }
}

export async function cacheClear(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(STORE);
  } catch {
    // ignore
  }
}
