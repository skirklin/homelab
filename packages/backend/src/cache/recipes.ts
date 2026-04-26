/**
 * Recipes backend cache decorator.
 *
 * Subscriptions deliver per-box callbacks rather than a single full-state
 * payload, so we cache an index of known box IDs plus each box's snapshot.
 */
import type { RecipesBackend, RecipesUser } from "../interfaces/recipes";
import type { RecipeBox, Recipe, CookingLogEvent } from "../types/recipes";
import type { Unsubscribe } from "../types/common";
import { cachedRead } from "./helpers";
import { cacheGet, cacheSet } from "./storage";

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

    subscribeToUser(userId, handlers): Unsubscribe {
      const userKey = `recipes:user:${userId}`;
      const indexKey = `recipes:userBoxes:${userId}`;
      let liveSeenUser = false;
      const liveSeenBoxes = new Set<string>();

      // Hydrate user
      void (async () => {
        if (liveSeenUser) return;
        const cachedUser = await cacheGet<RecipesUser>(userKey);
        if (cachedUser && !liveSeenUser) handlers.onUser(cachedUser);
      })();

      // Hydrate per-box snapshots
      void (async () => {
        const ids = (await cacheGet<string[]>(indexKey)) ?? [];
        for (const boxId of ids) {
          if (liveSeenBoxes.has(boxId)) continue;
          const snap = await cacheGet<BoxSnapshot>(`recipes:box:${boxId}`);
          if (snap && !liveSeenBoxes.has(boxId)) {
            handlers.onBox(snap.box, snap.recipes);
          }
        }
      })();

      return inner.subscribeToUser(userId, {
        onUser: (u) => {
          liveSeenUser = true;
          void cacheSet(userKey, u);
          handlers.onUser(u);
        },
        onBox: (box, recipes) => {
          liveSeenBoxes.add(box.id);
          void cacheSet(`recipes:box:${box.id}`, { box, recipes });
          // Maintain index
          void (async () => {
            const ids = (await cacheGet<string[]>(indexKey)) ?? [];
            if (!ids.includes(box.id)) {
              await cacheSet(indexKey, [...ids, box.id]);
            }
          })();
          handlers.onBox(box, recipes);
        },
        onBoxRemoved: (boxId) => {
          void (async () => {
            const ids = (await cacheGet<string[]>(indexKey)) ?? [];
            await cacheSet(indexKey, ids.filter((id) => id !== boxId));
          })();
          handlers.onBoxRemoved(boxId);
        },
        onRecipeChanged: handlers.onRecipeChanged,
        onRecipeRemoved: handlers.onRecipeRemoved,
      });
    },
  };
}
