/**
 * Recipes backend interface.
 *
 * Covers: boxes, recipes, cooking log events, enrichment/pending changes.
 * Box subscription and recipe membership (subscribe/unsubscribe to a box).
 */
import type { Unsubscribe, Visibility } from "../types/common";
import type {
  RecipeBox,
  Recipe,
  RecipeData,
  PendingChanges,
  CookingLogEvent,
} from "../types/recipes";

/** Lightweight user info for the recipes context */
export interface RecipesUser {
  id: string;
  boxes: string[];
  lastSeenUpdateVersion: number;
}

export interface RecipesBackend {
  // --- User ---

  getUser(userId: string): Promise<RecipesUser | null>;
  setLastSeenUpdateVersion(userId: string, version: number): Promise<void>;

  // --- Box CRUD ---

  createBox(userId: string, name: string): Promise<string>;
  deleteBox(boxId: string): Promise<void>;
  setBoxVisibility(boxId: string, visibility: Visibility): Promise<void>;

  /** Add current user as subscriber (not owner) of a box. */
  subscribeToBox(userId: string, boxId: string): Promise<void>;
  unsubscribeFromBox(userId: string, boxId: string): Promise<void>;

  // --- Recipe CRUD ---

  getBox(boxId: string, userId: string | null): Promise<{ box: RecipeBox; recipes: Recipe[] } | null>;
  addRecipe(boxId: string, recipe: RecipeData, userId: string): Promise<string>;
  saveRecipe(recipeId: string, data: RecipeData, userId: string): Promise<void>;
  deleteRecipe(recipeId: string): Promise<void>;
  setRecipeVisibility(recipeId: string, visibility: Visibility): Promise<void>;

  // --- Enrichment / pending changes ---

  applyChanges(
    recipeId: string,
    changes: PendingChanges,
    currentRecipe?: { description?: string; tags?: string[] },
  ): Promise<void>;
  rejectChanges(recipeId: string, source?: string): Promise<void>;

  // --- Cooking log ---

  getCookingLogEvents(boxId: string, recipeId: string): Promise<CookingLogEvent[]>;
  addCookingLogEvent(boxId: string, recipeId: string, userId: string, options?: { notes?: string; timestamp?: Date }): Promise<string>;
  updateCookingLogEvent(eventId: string, notes: string): Promise<void>;
  deleteCookingLogEvent(eventId: string): Promise<void>;

  // --- Subscriptions ---

  /**
   * Subscribe to the user's recipe state — boxes, recipes, and changes.
   * The callback fires on initial load and after every relevant change.
   */
  subscribeToUser(
    userId: string,
    handlers: {
      onUser: (user: RecipesUser) => void;
      onBox: (box: RecipeBox, recipes: Recipe[]) => void;
      onBoxRemoved: (boxId: string) => void;
      onRecipeChanged: (boxId: string, recipe: Recipe) => void;
      onRecipeRemoved: (boxId: string, recipeId: string) => void;
    },
  ): Unsubscribe;
}
