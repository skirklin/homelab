/**
 * Suggestions are derived from `shopping_trips` — completed trips are the
 * record of every ingredient the user has ever bought on this list, and each
 * trip item carries the category it was bought under. The most recently
 * completed trip's category wins when an ingredient appears in multiple trips.
 *
 * This replaces the old `shopping_history` collection (retired May 2026): the
 * user's mental model is that trips are the source of truth, and editing a
 * trip item directly changes both the visible record and future suggestions
 * in one motion.
 */
import type { ShoppingTrip, CategoryId } from "./types";

export interface Suggestion {
  /** Normalized (lowercased + trimmed) ingredient. New writes are stored
   *  pre-normalized at the backend (see `normalizeIngredient` in
   *  `pocketbase/shopping.ts`); old capitalized trip rows surface here as
   *  lowercase too because we display the dedup key, not the raw text. */
  ingredient: string;
  categoryId: CategoryId;
  /** Most-recent `trip.completedAt` this ingredient was observed on. */
  lastSeen: Date;
}

/**
 * Build a Map keyed by normalized (lowercased + trimmed) ingredient name,
 * with the most-recent category and `lastSeen` per key. Multiple trips with
 * the same ingredient (any casing) collapse to one entry; the newest trip
 * wins category. The display ingredient is always the normalized key so
 * mixed-case data from before the lowercase-on-write change still surfaces
 * consistently.
 *
 * Pure: same input → same output. Suitable for direct use in a `useMemo`.
 */
export function deriveSuggestions(trips: ShoppingTrip[]): Map<string, Suggestion> {
  const out = new Map<string, Suggestion>();
  for (const trip of trips) {
    const ts = trip.completedAt instanceof Date
      ? trip.completedAt.getTime()
      : new Date(trip.completedAt).getTime();
    if (Number.isNaN(ts)) continue;
    for (const item of trip.items) {
      const key = item.ingredient.toLowerCase().trim();
      if (!key) continue;
      const prior = out.get(key);
      if (!prior || ts > prior.lastSeen.getTime()) {
        out.set(key, {
          ingredient: key,
          categoryId: item.categoryId,
          lastSeen: trip.completedAt instanceof Date ? trip.completedAt : new Date(trip.completedAt),
        });
      }
    }
  }
  return out;
}
