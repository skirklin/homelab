/**
 * Adapters between @homelab/backend types and the recipes app's class-based types.
 *
 * The backend returns plain objects (Recipe, RecipeBox, RecipesUser).
 * The app uses class instances (RecipeEntry, BoxEntry, UserEntry) with methods.
 */
import type { Recipe as BackendRecipe, RecipeBox, RecipeData } from "@homelab/backend";
import type { RecipesUser } from "@homelab/backend";
import { BoxEntry, RecipeEntry, UserEntry, type PlainRecipe, type PlainBox, type PlainUser, getRecipeData } from "./storage";
import { type CookingLogEntry, EnrichmentStatus, Visibility } from "./types";
import { CURRENT_UPDATE_VERSION } from "./Modals/WhatsNew";

/** Convert a backend Recipe to the app's RecipeEntry class */
export function recipeFromBackend(r: BackendRecipe): RecipeEntry {
  const cookingLog: CookingLogEntry[] = Array.isArray(r.cookingLog)
    ? (r.cookingLog as Array<{ madeAt?: string; madeBy?: string; note?: string }>).map(
        (entry) => ({
          madeAt: entry.madeAt ? new Date(entry.madeAt) : new Date(r.created),
          madeBy: entry.madeBy || "",
          note: entry.note,
        }),
      )
    : [];

  return new RecipeEntry(
    r.data as import("schema-dts").Recipe,
    r.owners || [],
    (r.visibility as Visibility) || Visibility.private,
    r.creator || r.owners?.[0] || "",
    r.id,
    new Date(r.created),
    new Date(r.updated),
    r.lastUpdatedBy || "",
    r.pendingChanges || undefined,
    r.stepIngredients || undefined,
    cookingLog,
    (r.enrichmentStatus as EnrichmentStatus) || EnrichmentStatus.needed,
  );
}

/** Convert a backend RecipeBox to the app's BoxEntry class */
export function boxFromBackend(b: RecipeBox): BoxEntry {
  return new BoxEntry(
    { name: b.name || "", description: b.description || undefined },
    b.owners || [],
    (b.visibility as Visibility) || Visibility.private,
    b.creator || b.owners?.[0] || "",
    b.id,
    new Date(b.created),
    new Date(b.updated),
    b.lastUpdatedBy || "",
    b.subscribers || [],
  );
}

/** Convert a backend RecipesUser to the app's UserEntry class */
export function userFromBackend(u: RecipesUser): UserEntry {
  return new UserEntry(
    "", // backend RecipesUser doesn't carry a name
    Visibility.private,
    u.boxes,
    new Date(), // RecipesUser doesn't have timestamps
    new Date(),
    u.id,
    u.lastSeenUpdateVersion || CURRENT_UPDATE_VERSION,
  );
}

/** Extract plain RecipeData from a RecipeEntry for backend calls */
export function recipeDataToBackend(r: RecipeEntry | PlainRecipe): RecipeData {
  if (r instanceof RecipeEntry) {
    return r.getData() as unknown as RecipeData;
  }
  return getRecipeData(r) as unknown as RecipeData;
}

// ─── Plain-object adapters (parallel to the class-based ones above) ────────
// Used while the recipes app migrates off RecipeEntry/BoxEntry/UserEntry.
// Returns plain objects matching PlainRecipe/PlainBox/PlainUser.

export function recipeFromBackendPlain(r: BackendRecipe): PlainRecipe {
  return {
    id: r.id,
    data: r.data as import("schema-dts").Recipe,
    owners: r.owners || [],
    editing: false,
    creator: r.creator || r.owners?.[0] || "",
    visibility: (r.visibility as Visibility) || Visibility.private,
    created: new Date(r.created),
    updated: new Date(r.updated),
    lastUpdatedBy: r.lastUpdatedBy || "",
    pendingChanges: r.pendingChanges || undefined,
    stepIngredients: r.stepIngredients || undefined,
    enrichmentStatus: (r.enrichmentStatus as EnrichmentStatus) || EnrichmentStatus.needed,
  };
}

export function boxFromBackendPlain(b: RecipeBox): PlainBox {
  return {
    id: b.id,
    data: { name: b.name || "", description: b.description || undefined },
    owners: b.owners || [],
    subscribers: b.subscribers || [],
    creator: b.creator || b.owners?.[0] || "",
    visibility: (b.visibility as Visibility) || Visibility.private,
    recipes: new Map(),
    created: new Date(b.created),
    updated: new Date(b.updated),
    lastUpdatedBy: b.lastUpdatedBy || "",
  };
}

export function userFromBackendPlain(u: RecipesUser): PlainUser {
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

/** Convert app PendingChanges to backend PendingChanges (data is required in backend type) */
export function pendingChangesToBackend(
  changes: import("./types").PendingChanges,
): import("@homelab/backend").PendingChanges {
  return {
    ...changes,
    data: changes.data || {},
  } as import("@homelab/backend").PendingChanges;
}
