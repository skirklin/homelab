/**
 * Adapters between @homelab/backend types and the recipes app's local types.
 *
 * The backend returns plain objects (Recipe, RecipeBox, RecipesUser).
 * The app stores them as PlainRecipe / PlainBox / PlainUser.
 */
import type { Recipe as BackendRecipe, RecipeBox, RecipeData } from "@homelab/backend";
import type { RecipesUser } from "@homelab/backend";
import { type PlainRecipe, type PlainBox, type PlainUser, getRecipeData } from "./storage";
import { EnrichmentStatus, Visibility } from "./types";

// Newly-onboarded users default to the latest update version so the
// CookingMode "new feature" popover (the only remaining consumer of this
// field) doesn't fire for users who never saw the prior WhatsNew modal.
// Bump in lockstep with COOKING_MODE_VERSION in Header/CookingMode.tsx when
// a new "what's new" hint is added.
const CURRENT_UPDATE_VERSION = 2;

export function recipeFromBackend(r: BackendRecipe): PlainRecipe {
  const creator = r.creator || r.owners?.[0] || "";
  return {
    id: r.id,
    data: r.data as import("schema-dts").Recipe,
    owners: r.owners || [],
    editing: false,
    creator,
    visibility: (r.visibility as Visibility) || Visibility.private,
    created: new Date(r.created),
    updated: new Date(r.updated),
    // Match the legacy RecipeEntry constructor: fall back to creator when
    // lastUpdatedBy is missing.
    lastUpdatedBy: r.lastUpdatedBy || creator,
    pendingChanges: r.pendingChanges || undefined,
    stepIngredients: r.stepIngredients || undefined,
    enrichmentStatus: (r.enrichmentStatus as EnrichmentStatus) || EnrichmentStatus.needed,
  };
}

export function boxFromBackend(b: RecipeBox): PlainBox {
  const creator = b.creator || b.owners?.[0] || "";
  return {
    id: b.id,
    data: { name: b.name || "", description: b.description || undefined },
    owners: b.owners || [],
    subscribers: b.subscribers || [],
    creator,
    visibility: (b.visibility as Visibility) || Visibility.private,
    recipes: new Map(),
    created: new Date(b.created),
    updated: new Date(b.updated),
    // Match the legacy BoxEntry constructor's lastUpdatedBy fallback.
    lastUpdatedBy: b.lastUpdatedBy || creator,
  };
}

export function userFromBackend(u: RecipesUser): PlainUser {
  return {
    id: u.id,
    name: "",
    visibility: Visibility.private,
    boxes: u.boxes,
    lastSeen: new Date(),
    newSeen: new Date(),
    lastSeenUpdateVersion: u.lastSeenUpdateVersion || CURRENT_UPDATE_VERSION,
  };
}

/** Extract plain RecipeData from a PlainRecipe for backend calls */
export function recipeDataToBackend(r: PlainRecipe): RecipeData {
  return getRecipeData(r) as unknown as RecipeData;
}

/** Convert app PendingChanges to backend PendingChanges (data is required in backend type) */
export function pendingChangesToBackend(
  changes: import("./types").PendingChanges,
): import("@homelab/backend").PendingChanges {
  return {
    ...changes,
    data: changes.data || {},
  } as import("@homelab/backend").PendingChanges;
}
