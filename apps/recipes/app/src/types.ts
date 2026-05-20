import type { Comment, Recipe } from 'schema-dts';
import type { PlainBox, PlainRecipe, PlainUser } from './storage';

export type BoxId = string
export type RecipeId = string
export type UserId = string

export type BoxType = {
  name: string,
  description?: string,
}

export type StepIngredients = Record<string, string[]>;  // { "0": ["1 cup flour"], "1": ["2 eggs"] }

// Generic pending changes to a recipe document
export type PendingChanges = {
  // Proposed changes to recipe.data fields
  data?: {
    name?: string,
    description?: string,
    recipeIngredient?: string[],
    recipeInstructions?: Array<{ text: string, '@type'?: string }>,
    recipeCategory?: string[],
  },
  // Proposed changes to document-level fields
  stepIngredients?: StepIngredients,

  // Metadata
  source: 'enrichment' | 'modification',
  prompt?: string,  // User's request (for modifications)
  reasoning: string,
  generatedAt: string,  // ISO date string
  model: string,
}

export type CookingLogEntry = {
  madeAt: Date,
  madeBy: string,  // UserId
  note?: string,
}

export type AppState = {
  boxes: Map<string, PlainBox>
  users: Map<string, PlainUser>
  writeable: boolean
  loading: number
  subscriptionsReady: boolean  // true once initial subscription loading completes
}

// Discriminated union of all reducer actions. Each variant carries only the
// fields it needs, so callers (and TS) can't accidentally mix them.
export type ActionType =
  | { type: "INCR_LOADING" }
  | { type: "DECR_LOADING" }
  | { type: "SET_LOADING"; loading: number }
  | { type: "RESET_STATE" }
  | { type: "ADD_USER"; user?: PlainUser }
  | { type: "ADD_RECIPE"; boxId?: BoxId; recipeId?: RecipeId; payload?: PlainRecipe }
  | { type: "ADD_BOX"; boxId?: BoxId; payload?: PlainBox }
  | { type: "REMOVE_BOX"; boxId?: BoxId }
  | { type: "REMOVE_RECIPE"; boxId?: BoxId; recipeId?: RecipeId }
  | { type: "SET_BOXES"; payload: Map<string, PlainBox> }
  | { type: "CLEAR_BOXES" }
  | { type: "SET_READONLY"; payload: boolean }
  | { type: "SET_RECIPE_NAME"; recipeId?: RecipeId; boxId?: BoxId; payload?: string }
  | { type: "SET_INGREDIENTS"; recipeId?: RecipeId; boxId?: BoxId; payload?: Recipe["recipeIngredient"] }
  | { type: "SET_CATEGORIES"; recipeId?: RecipeId; boxId?: BoxId; payload?: Recipe["recipeCategory"] }
  | { type: "SET_COMMENT"; recipeId?: RecipeId; boxId?: BoxId; payload?: Comment }
  | { type: "SET_AUTHOR"; recipeId?: RecipeId; boxId?: BoxId; payload?: Recipe["author"] }
  | { type: "SET_DESCRIPTION"; recipeId?: RecipeId; boxId?: BoxId; payload?: string }
  | { type: "SET_INSTRUCTIONS"; recipeId?: RecipeId; boxId?: BoxId; payload?: Recipe["recipeInstructions"] }
  | { type: "SET_EDITABLE"; recipeId?: RecipeId; boxId?: BoxId }
  | { type: "RESET_RECIPE"; recipeId?: RecipeId; boxId?: BoxId }
  | { type: "SET_BOX_NAME"; boxId?: BoxId; payload?: string }
  | { type: "RESET_BOX"; boxId?: BoxId }
  // Catch-all for unknown action types (preserves the prior "unknown action returns state" behaviour
  // and lets the existing test for `{ type: "UNKNOWN_ACTION" }` typecheck).
  | { type: string }

export type UnsubMap = {
  userUnsub: (() => void) | undefined,
  boxesUnsub: (() => void) | undefined,
  boxMap: Map<string, {
    boxUnsub: (() => void) | undefined,
    recipesUnsub: (() => void) | undefined,
  }>
}

export enum Visibility {
  private = "private", // only owner can read
  // linkable = "linkable", // anyone with link can read
  public = "public", // discoverable
}

export enum EnrichmentStatus {
  needed = "needed",     // newly created/edited, needs AI processing
  pending = "pending",   // AI generated suggestions, waiting for user review
  done = "done",         // user accepted enrichment
  skipped = "skipped",   // user rejected or recipe already had content
}
