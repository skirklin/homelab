/**
 * IndexedDB backing for the optimistic-write mutation queue AND the
 * persistent server-snapshot cache.
 *
 * Two object stores:
 *   - `mutations`, keyed by mutation id — the durable optimistic-write queue.
 *   - `snapshots`, keyed by `${user}::${collection}::${id}` — cached server
 *     records so a cold load can paint stale-while-revalidate instead of
 *     blocking on the network. Indexed by `user` for scoped hydration.
 *
 * The DB and store names live here so persistence.ts / snapshot-persistence.ts
 * and any future tooling share a single source of truth.
 */
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "kirkl-cache";
const DB_VERSION = 3;
export const MUTATIONS_STORE = "mutations";
export const SNAPSHOTS_STORE = "snapshots";
/**
 * Legacy key/value store from the deleted cache decorator. Dropped in the
 * v3 upgrade (nothing has read or written it since packages/backend/src/cache/
 * was removed). We delete it rather than carry it forward.
 */
const LEGACY_KV_STORE = "kv";

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDb(): Promise<IDBPDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // NEVER touch `mutations` here — in-flight optimistic writes from a
        // mid-deploy reload must survive the schema bump. Only create what's
        // absent and drop the dead legacy store.
        if (!db.objectStoreNames.contains(MUTATIONS_STORE)) {
          db.createObjectStore(MUTATIONS_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(SNAPSHOTS_STORE)) {
          const store = db.createObjectStore(SNAPSHOTS_STORE, { keyPath: "key" });
          store.createIndex("user", "user");
        }
        if (db.objectStoreNames.contains(LEGACY_KV_STORE)) {
          db.deleteObjectStore(LEGACY_KV_STORE);
        }
      },
    });
  }
  return dbPromise;
}
