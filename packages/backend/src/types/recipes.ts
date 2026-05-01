/** Recipes domain types */

import type { Visibility, Event } from "./common";

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
  cookingLog: unknown;
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

export type CookingLogEvent = Event;
