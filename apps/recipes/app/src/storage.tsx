import _ from "lodash";
import type { Recipe } from "schema-dts";
import { type BoxType, type BoxId, type UserId, type PendingChanges, EnrichmentStatus, type StepIngredients, Visibility } from "./types";
import { decodeStr } from "./converters";

// ─── Plain-object types that AppState stores ────────────────────────────────
//
// These replaced the former RecipeEntry/BoxEntry/UserEntry classes. The class
// methods (clone/getName/getData/getDescription) live as standalone helpers
// below. The `Plain` prefix is kept so consumers signal "this is the local
// app shape" vs. the backend types.

export type PlainRecipe = {
  id: string;
  data: Recipe;
  changed?: Recipe;
  owners: string[];
  editing: boolean;
  creator: UserId;
  visibility: Visibility;
  created: Date;
  updated: Date;
  lastUpdatedBy: string;
  pendingChanges?: PendingChanges;
  stepIngredients?: StepIngredients;
  enrichmentStatus: EnrichmentStatus;
};

export type PlainBox = {
  id: string;
  data: BoxType;
  changed?: BoxType;
  owners: string[];
  subscribers: string[];
  creator: string;
  visibility: Visibility;
  recipes: Map<string, PlainRecipe>;
  created: Date;
  updated: Date;
  lastUpdatedBy: string;
};

export type PlainUser = {
  id: string;
  name: string;
  visibility: Visibility;
  boxes: BoxId[];
  lastSeen: Date;
  newSeen: Date;
  lastSeenUpdateVersion: number;
};

// ─── Helpers replacing the former class methods ─────────────────────────────

export function getRecipeData(r: Pick<PlainRecipe, "data" | "changed">): Recipe {
  return r.changed ? r.changed : r.data;
}

export function getRecipeName(r: Pick<PlainRecipe, "data" | "changed">): string | undefined {
  return decodeStr(getRecipeData(r).name as string);
}

export function getRecipeDescription(r: Pick<PlainRecipe, "data" | "changed">): string | undefined {
  return decodeStr(getRecipeData(r).description as string);
}

export function getBoxName(b: Pick<PlainBox, "data">): string | undefined {
  return decodeStr(b.data.name);
}

export function cloneRecipe(r: PlainRecipe): PlainRecipe {
  return {
    id: r.id,
    data: _.cloneDeep(r.data),
    changed: r.changed ? _.cloneDeep(r.changed) : undefined,
    owners: [...r.owners],
    editing: r.editing,
    creator: r.creator,
    visibility: r.visibility,
    created: r.created,
    updated: r.updated,
    lastUpdatedBy: r.lastUpdatedBy,
    pendingChanges: r.pendingChanges ? _.cloneDeep(r.pendingChanges) : undefined,
    stepIngredients: r.stepIngredients ? _.cloneDeep(r.stepIngredients) : undefined,
    enrichmentStatus: r.enrichmentStatus,
  };
}

export function cloneBox(b: PlainBox): PlainBox {
  return {
    id: b.id,
    data: _.cloneDeep(b.data),
    changed: b.changed ? _.cloneDeep(b.changed) : undefined,
    owners: [...b.owners],
    subscribers: [...b.subscribers],
    creator: b.creator,
    visibility: b.visibility,
    recipes: new Map(b.recipes),
    created: b.created,
    updated: b.updated,
    lastUpdatedBy: b.lastUpdatedBy,
  };
}
