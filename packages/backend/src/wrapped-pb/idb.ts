/**
 * IndexedDB backing for the optimistic-write mutation queue.
 *
 * One object store, `mutations`, keyed by mutation id. The DB and store
 * names live here so persistence.ts and any future tooling (e.g. a debug
 * panel that lists pending mutations) share a single source of truth.
 */
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "kirkl-cache";
const DB_VERSION = 2;
export const MUTATIONS_STORE = "mutations";
/**
 * Legacy key/value store, kept in the schema so the IDB upgrade path
 * doesn't trip on an existing DB that still has it. Nothing reads or
 * writes it after the cache decorator was removed (see commit deleting
 * packages/backend/src/cache/). Drop it on the next DB_VERSION bump if
 * the orphan object store ever becomes worth a migration.
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
        if (!db.objectStoreNames.contains(LEGACY_KV_STORE)) db.createObjectStore(LEGACY_KV_STORE);
        if (!db.objectStoreNames.contains(MUTATIONS_STORE)) {
          db.createObjectStore(MUTATIONS_STORE, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}
