/** Recipes domain types */

import type { Visibility } from "./common";
import type { LifeEntry } from "./life";

export interface RecipeBox {
  id: string;
  name: string;
  description: string;
  owners: string[];
  subscribers: string[];
  visibility: Visibility;
  created: string;
  updated: string;
  creator: string;
  lastUpdatedBy: string;
}

export interface Recipe {
  id: string;
  box: string;
  data: RecipeData;
  owners: string[];
  visibility: Visibility;
  enrichmentStatus: EnrichmentStatus;
  pendingChanges: PendingChanges | null;
  stepIngredients: Record<string, string[]> | null;
  created: string;
  updated: string;
  creator: string;
  lastUpdatedBy: string;
}

export interface RecipeData {
  "@type"?: string;
  name?: string;
  description?: string;
  url?: string;
  recipeIngredient?: string[];
  recipeInstructions?: RecipeInstruction[];
  recipeCategory?: string[];
  recipeYield?: string;
  prepTime?: string;
  cookTime?: string;
  [key: string]: unknown;
}

export interface RecipeInstruction {
  "@type"?: string;
  text: string;
  ingredients?: string[];
}

export type EnrichmentStatus = "needed" | "pending" | "done" | "skipped";

export interface PendingChanges {
  data: Partial<RecipeData>;
  stepIngredients?: Record<string, string[]>;
  source: "enrichment" | "modification";
  reasoning: string;
  prompt?: string;
  generatedAt: string;
  model: string;
}

/**
 * A persisted recipe_events row. Same unified shape as LifeEvent and
 * TaskCompletion — entries[] is the canonical place for per-cook data.
 * Today we write a text entry named "notes" and optionally a number entry
 * named "rating" (1–5, unit "stars"). `rating` below is derived from that
 * entry by the mapper — entries[] stays the storage of record.
 *
 * `recipeSnapshot` captures the full recipe.data blob at the moment the
 * entry was created. The UI uses it to diff "the recipe as it was when I
 * cooked it" against the live recipe ("milk: 3 cup → 4 cup"). Always
 * populated on new entries; undefined on rows that predate the feature
 * (they're not backfilled — the UI renders the diff affordance disabled
 * for them). Written on create only; updating notes/timestamp does NOT
 * re-snapshot — the snapshot represents the cook session, not the row.
 */
export interface CookingLogEvent {
  id: string;
  subjectId: string;
  timestamp: Date;
  /** Reserved for interval cooks (e.g. multi-session bakes); unused today. */
  endTime?: Date;
  entries: LifeEntry[];
  /** 1–5 star rating, derived from the "rating" number entry. */
  rating?: number;
  labels?: Record<string, string>;
  recipeSnapshot?: RecipeData;
  createdBy: string;
  created: string;
  updated: string;
}
