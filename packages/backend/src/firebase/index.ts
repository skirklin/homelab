/**
 * Firebase backend factory.
 *
 * Usage:
 *   import { createFirebaseBackends } from "@homelab/backend/firebase";
 *   const backends = createFirebaseBackends(db);
 *   const { shopping, user } = backends;
 */
import type { Firestore } from "firebase/firestore";
import { FirebaseShoppingBackend } from "./shopping";
import { FirebaseUserBackend } from "./user";
import { FirebaseRecipesBackend } from "./recipes";

export function createFirebaseBackends(db: Firestore) {
  return {
    shopping: new FirebaseShoppingBackend(db) as import("../interfaces/shopping").ShoppingBackend,
    user: new FirebaseUserBackend(db) as import("../interfaces/user").UserBackend,
    recipes: new FirebaseRecipesBackend(db) as import("../interfaces/recipes").RecipesBackend,
    // Future: upkeep, travel, life
  };
}

export { FirebaseShoppingBackend } from "./shopping";
export { FirebaseUserBackend } from "./user";
export { FirebaseRecipesBackend } from "./recipes";
