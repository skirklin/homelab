/**
 * Track recently viewed recipes in localStorage.
 * Used to boost recently viewed recipes to the top of the list.
 */

const STORAGE_KEY = "recipes:recentlyViewed";
const MAX_ENTRIES = 50;

interface ViewEntry {
  id: string;
  ts: number;
}

function load(): ViewEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function save(entries: ViewEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

export function recordRecentView(recipeId: string) {
  const entries = load().filter(e => e.id !== recipeId);
  entries.unshift({ id: recipeId, ts: Date.now() });
  save(entries);
}

/**
 * Returns a map of recipe ID → view timestamp (most recent view).
 * Recipes not in the map have never been viewed.
 */
export function getRecentViews(): Map<string, number> {
  return new Map(load().map(e => [e.id, e.ts]));
}
