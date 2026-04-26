/**
 * Lightweight IndexedDB key/value cache for offline reads.
 *
 * One global object store. Keys are namespaced strings like
 * `travel:trips:<logId>` so each backend can claim its own prefix.
 */
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "kirkl-cache";
const DB_VERSION = 1;
const STORE = "kv";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
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
