/**
 * Namespaced localStorage utility for groceries app.
 */

import { createAppStorage, migrateStorageKey } from "@kirkl/shared";

export const appStorage = createAppStorage("groceries");

// Run migrations on import
migrateStorageKey("groceries-last-list", "lastList", appStorage);

// Storage keys (typed constants for IDE autocomplete)
export const StorageKeys = {
  LAST_LIST: "lastList",
} as const;
