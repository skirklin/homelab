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
import { wrapPocketBase, type WrappedPocketBase } from "../wrapped-pb";

export function createPocketBaseBackends(getPb: () => PocketBase) {
  const wpb: WrappedPocketBase = wrapPocketBase(getPb);
  return {
    shopping: new PocketBaseShoppingBackend(getPb, wpb) as import("../interfaces/shopping").ShoppingBackend,
    user: new PocketBaseUserBackend(getPb, wpb) as import("../interfaces/user").UserBackend,
    recipes: new PocketBaseRecipesBackend(getPb, wpb) as import("../interfaces/recipes").RecipesBackend,
    upkeep: new PocketBaseUpkeepBackend(getPb, wpb) as import("../interfaces/upkeep").UpkeepBackend,
    travel: new PocketBaseTravelBackend(getPb, wpb) as import("../interfaces/travel").TravelBackend,
    life: new PocketBaseLifeBackend(getPb, wpb) as import("../interfaces/life").LifeBackend,
    /** Shared optimistic-write wrapper. Call replayPending() once after auth ready. */
    wpb,
  };
}

export { PocketBaseShoppingBackend } from "./shopping";
export { PocketBaseUserBackend } from "./user";
export { PocketBaseRecipesBackend } from "./recipes";
export { PocketBaseUpkeepBackend } from "./upkeep";
export { PocketBaseTravelBackend } from "./travel";
export { PocketBaseLifeBackend } from "./life";
