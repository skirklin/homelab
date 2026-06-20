/**
 * Namespaced localStorage utility for upkeep app.
 */

import { createAppStorage, migrateStorageKey } from "@kirkl/shared";

export const appStorage = createAppStorage("upkeep");

migrateStorageKey("upkeep-last-list", "lastList", appStorage);

export const StorageKeys = {
  LAST_LIST: "lastList",
} as const;
