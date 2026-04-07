/**
 * Namespaced localStorage utility for shopping app.
 */

import { createAppStorage, migrateStorageKey } from "@kirkl/shared";

export const appStorage = createAppStorage("shopping");

// Run migrations on import (from old "groceries" namespace)
migrateStorageKey("groceries-last-list", "lastList", appStorage);

// Storage keys (typed constants for IDE autocomplete)
export const StorageKeys = {
  LAST_LIST: "lastList",
} as const;
