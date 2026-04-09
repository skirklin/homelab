/**
 * PocketBase backend factory.
 *
 * Usage:
 *   import { createPocketBaseBackends } from "@homelab/backend/pocketbase";
 *   const backends = createPocketBaseBackends(() => getBackend());
 *   const { shopping, user } = backends;
 */
import type PocketBase from "pocketbase";
import { PocketBaseShoppingBackend } from "./shopping";
import { PocketBaseUserBackend } from "./user";
import { PocketBaseRecipesBackend } from "./recipes";
import { PocketBaseUpkeepBackend } from "./upkeep";
import { PocketBaseTravelBackend } from "./travel";
import { PocketBaseLifeBackend } from "./life";

export function createPocketBaseBackends(getPb: () => PocketBase) {
  return {
    shopping: new PocketBaseShoppingBackend(getPb) as import("../interfaces/shopping").ShoppingBackend,
    user: new PocketBaseUserBackend(getPb) as import("../interfaces/user").UserBackend,
    recipes: new PocketBaseRecipesBackend(getPb) as import("../interfaces/recipes").RecipesBackend,
    upkeep: new PocketBaseUpkeepBackend(getPb) as import("../interfaces/upkeep").UpkeepBackend,
    travel: new PocketBaseTravelBackend(getPb) as import("../interfaces/travel").TravelBackend,
    life: new PocketBaseLifeBackend(getPb) as import("../interfaces/life").LifeBackend,
  };
}

export { PocketBaseShoppingBackend } from "./shopping";
export { PocketBaseUserBackend } from "./user";
export { PocketBaseRecipesBackend } from "./recipes";
export { PocketBaseUpkeepBackend } from "./upkeep";
export { PocketBaseTravelBackend } from "./travel";
export { PocketBaseLifeBackend } from "./life";
