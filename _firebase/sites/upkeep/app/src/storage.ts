/**
 * Namespaced localStorage utility for upkeep app.
 */

import { createAppStorage, migrateStorageKey } from "@kirkl/shared";

export const appStorage = createAppStorage("upkeep");

// Run migrations on import
migrateStorageKey("upkeep-last-list", "lastList", appStorage);

// Storage keys (typed constants for IDE autocomplete)
export const StorageKeys = {
  LAST_LIST: "lastList",
} as const;
