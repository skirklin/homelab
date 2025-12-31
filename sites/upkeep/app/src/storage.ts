/**
 * Namespaced localStorage utility for app-specific state.
 * All keys are stored under "kirkl:upkeep:{key}" to avoid collisions.
 */

const NAMESPACE = "kirkl:upkeep";

function getKey(key: string): string {
  return `${NAMESPACE}:${key}`;
}

export const appStorage = {
  get<T>(key: string, defaultValue: T): T {
    try {
      const item = localStorage.getItem(getKey(key));
      return item ? JSON.parse(item) : defaultValue;
    } catch {
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

  // Migrate from old flat keys (run once on app init)
  migrateFromLegacy(): void {
    const oldKey = "upkeep-last-list";
    const oldValue = localStorage.getItem(oldKey);
    if (oldValue) {
      this.set("lastList", oldValue);
      localStorage.removeItem(oldKey);
      console.log("[storage] Migrated upkeep-last-list to namespaced storage");
    }
  },
};

// Storage keys (typed constants for IDE autocomplete)
export const StorageKeys = {
  LAST_LIST: "lastList",
  // Add more as needed:
  // SEEN_NOTIFICATIONS: "seenNotifications",
  // UI_PREFERENCES: "uiPreferences",
} as const;
