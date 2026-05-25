/**
 * Recipes backend cache decorator.
 *
 * Kept as a thin pass-through for the read-only helpers that still cache
 * to IDB (`getUser`, `getBox`, `getCookingLogEvents`). The subscription
 * path is now mirror-backed and doesn't need the hydrate-one snapshot
 * layer — see cache/index.ts.
 */
import type { RecipesBackend, RecipesUser } from "../interfaces/recipes";
import type { RecipeBox, Recipe, CookingLogEvent } from "../types/recipes";
import { cachedRead } from "./helpers";

type BoxSnapshot = { box: RecipeBox; recipes: Recipe[] };

export function withRecipesCache(inner: RecipesBackend): RecipesBackend {
  return {
    getUser: (userId) => cachedRead<RecipesUser | null>(`recipes:user:${userId}`, () => inner.getUser(userId)),
    getBox: (boxId, userId) =>
      cachedRead<BoxSnapshot | null>(`recipes:box:${boxId}`, () => inner.getBox(boxId, userId)),
    getCookingLogEvents: (boxId, recipeId) =>
      cachedRead<CookingLogEvent[]>(`recipes:cookingLog:${boxId}:${recipeId}`, () =>
        inner.getCookingLogEvents(boxId, recipeId),
      ),

    setLastSeenUpdateVersion: (id, v) => inner.setLastSeenUpdateVersion(id, v),
    createBox: (id, n) => inner.createBox(id, n),
    deleteBox: (id) => inner.deleteBox(id),
    setBoxVisibility: (id, v) => inner.setBoxVisibility(id, v),
    subscribeToBox: (uid, bid) => inner.subscribeToBox(uid, bid),
    unsubscribeFromBox: (uid, bid) => inner.unsubscribeFromBox(uid, bid),
    addRecipe: (bid, r, uid) => inner.addRecipe(bid, r, uid),
    saveRecipe: (id, d, uid) => inner.saveRecipe(id, d, uid),
    deleteRecipe: (id) => inner.deleteRecipe(id),
    setRecipeVisibility: (id, v) => inner.setRecipeVisibility(id, v),
    applyChanges: (id, c, cur) => inner.applyChanges(id, c, cur),
    rejectChanges: (id, src) => inner.rejectChanges(id, src),
    addCookingLogEvent: (bid, rid, uid, opts) => inner.addCookingLogEvent(bid, rid, uid, opts),
    updateCookingLogEvent: (id, n) => inner.updateCookingLogEvent(id, n),
    deleteCookingLogEvent: (id) => inner.deleteCookingLogEvent(id),
    subscribeToCookingLog: (bid, rid, cb) => inner.subscribeToCookingLog(bid, rid, cb),
    subscribeToUser: (uid, h) => inner.subscribeToUser(uid, h),
  };
}
