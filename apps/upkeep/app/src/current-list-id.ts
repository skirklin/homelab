/**
 * Module-level singleton tracking the current upkeep list ID.
 * Extracted from pocketbase.ts so other modules can reference it
 * without depending on the deprecated PocketBase direct-access layer.
 */

let currentListId = "default";

export function setCurrentListId(listId: string) {
  currentListId = listId;
}

export function getCurrentListId() {
  return currentListId;
}
