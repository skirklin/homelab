/**
 * Factory for creating namespaced localStorage utilities.
 * Each app gets its own namespace to avoid key collisions.
 */

export interface AppStorage {
  get<T>(key: string, defaultValue: T): T;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
}

/**
 * Create a namespaced localStorage utility for an app.
 *
 * @param namespace - Unique namespace for the app (e.g., "groceries", "upkeep")
 * @returns Storage utility with get, set, and remove methods
 *
 * @example
 * const storage = createAppStorage("groceries");
 * storage.set("lastList", "weekly");
 * const lastList = storage.get("lastList", null);
 */
export function createAppStorage(namespace: string): AppStorage {
  const prefix = `kirkl:${namespace}`;

  function getKey(key: string): string {
    return `${prefix}:${key}`;
  }

  return {
    get<T>(key: string, defaultValue: T): T {
      const fullKey = getKey(key);
      try {
        const item = localStorage.getItem(fullKey);
        return item ? JSON.parse(item) : defaultValue;
      } catch (e) {
        console.warn(`[storage] Corrupted data at "${fullKey}", using default value:`, e);
        return defaultValue;
      }
    },

    set<T>(key: string, value: T): void {
      try {
        localStorage.setItem(getKey(key), JSON.stringify(value));
      } catch (e) {
        console.error("Failed to save to localStorage:", e);
      }
    },

    remove(key: string): void {
      localStorage.removeItem(getKey(key));
    },
  };
}

/**
 * Migrate from legacy flat localStorage keys to namespaced storage.
 *
 * @param oldKey - The old key to migrate from
 * @param newKey - The new key to migrate to
 * @param storage - The app storage instance to migrate to
 */
export function migrateStorageKey(oldKey: string, newKey: string, storage: AppStorage): void {
  const oldValue = localStorage.getItem(oldKey);
  if (oldValue) {
    try {
      storage.set(newKey, JSON.parse(oldValue));
    } catch {
      storage.set(newKey, oldValue);
    }
    localStorage.removeItem(oldKey);
    console.log(`[storage] Migrated ${oldKey} to namespaced storage`);
  }
}
