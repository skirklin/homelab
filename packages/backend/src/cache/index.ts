/**
 * Offline cache decorator for backends.
 *
 * Usage:
 *   import { createPocketBaseBackends } from "@homelab/backend/pocketbase";
 *   import { withCache } from "@homelab/backend/cache";
 *   const backends = withCache(createPocketBaseBackends(() => getPb()));
 *
 * Reads are served from IndexedDB while offline; writes pass through and
 * will reject when the network is unavailable. Subscriptions hydrate from
 * cache immediately, then overlay live PocketBase updates as they arrive.
 */
import { withTravelCache } from "./travel";
import { withShoppingCache } from "./shopping";
import { withUpkeepCache } from "./upkeep";
import { withRecipesCache } from "./recipes";
import { withLifeCache } from "./life";
import { withUserCache } from "./user";

import type { TravelBackend } from "../interfaces/travel";
import type { ShoppingBackend } from "../interfaces/shopping";
import type { UpkeepBackend } from "../interfaces/upkeep";
import type { RecipesBackend } from "../interfaces/recipes";
import type { LifeBackend } from "../interfaces/life";
import type { UserBackend } from "../interfaces/user";

export interface BackendBundle {
  travel: TravelBackend;
  shopping: ShoppingBackend;
  upkeep: UpkeepBackend;
  recipes: RecipesBackend;
  life: LifeBackend;
  user: UserBackend;
}

export function withCache(b: BackendBundle): BackendBundle {
  return {
    travel: withTravelCache(b.travel),
    shopping: withShoppingCache(b.shopping),
    upkeep: withUpkeepCache(b.upkeep),
    recipes: withRecipesCache(b.recipes),
    life: withLifeCache(b.life),
    user: withUserCache(b.user),
  };
}

export { cacheClear } from "./storage";
export {
  withTravelCache,
  withShoppingCache,
  withUpkeepCache,
  withRecipesCache,
  withLifeCache,
  withUserCache,
};
