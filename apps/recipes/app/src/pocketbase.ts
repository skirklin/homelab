/**
 * PocketBase data operations for the recipes app.
 * Replaces the old firestore.ts.
 */
import { getBackend } from "@kirkl/shared";
import type { RecordModel } from "pocketbase";
import type React from 'react';
import type { Recipe } from "schema-dts";
import { type Event, eventFromStore } from '@kirkl/shared';
import { BoxEntry, RecipeEntry, UserEntry, boxFromRecord, recipeFromRecord, userFromRecord } from './storage';
import { type ActionType, type BoxId, EnrichmentStatus, type RecipeId, type UserId, Visibility } from './types';

function pb() {
  return getBackend();
}

export async function getRecipe(boxes: Map<string, BoxEntry>, boxId: BoxId | undefined, recipeId: RecipeId | undefined) {
  let recipe: RecipeEntry | undefined;
  if (boxId === undefined || recipeId === undefined) {
    return undefined;
  }
  const box = boxes.get(boxId);
  if (box !== undefined) {
    recipe = box.recipes.get(recipeId);
  } else {
    try {
      const record = await pb().collection("recipes").getOne(recipeId);
      recipe = recipeFromRecord(record);
    } catch {
      return undefined;
    }
  }
  return recipe;
}

export async function getRecipes(box: BoxEntry, userId: string | null) {
  const recipes = new Map<string, RecipeEntry>();
  if (userId === null) {
    return recipes;
  }
  try {
    const records = await pb().collection("recipes").getFullList({
      filter: `box = "${box.id}"`,
    });
    for (const record of records) {
      recipes.set(record.id, recipeFromRecord(record));
    }
  } catch (e) {
    console.error("Failed to fetch recipes:", e);
  }
  return recipes;
}

export async function getBox(boxId: BoxId, userId: string | null) {
  try {
    const record = await pb().collection("recipe_boxes").getOne(boxId);
    const box = boxFromRecord(record);
    box.recipes = await getRecipes(box, userId);
    return box;
  } catch {
    return undefined;
  }
}

export async function getUser(userId: UserId) {
  try {
    const record = await pb().collection("users").getOne(userId);
    return userFromRecord(record);
  } catch {
    return undefined;
  }
}

export async function subscribeToBox(user: UserEntry | null, boxId: BoxId) {
  if (user === null) {
    return undefined;
  }
  // Add box to user's recipe_boxes list
  const userRecord = await pb().collection("users").getOne(user.id);
  const boxes: string[] = userRecord.recipe_boxes || [];
  if (!boxes.includes(boxId)) {
    await pb().collection("users").update(user.id, {
      recipe_boxes: [...boxes, boxId],
    });
  }
  // Add user as subscriber on the box
  await pb().collection("recipe_boxes").update(boxId, {
    "subscribers+": user.id,
  });
}

export async function unsubscribeFromBox(user: UserEntry | null, boxId: BoxId) {
  if (user === null) {
    return undefined;
  }
  // Remove box from user's recipe_boxes list
  const userRecord = await pb().collection("users").getOne(user.id);
  const boxes: string[] = userRecord.recipe_boxes || [];
  await pb().collection("users").update(user.id, {
    recipe_boxes: boxes.filter((b: string) => b !== boxId),
  });
  // Remove user as subscriber on the box
  await pb().collection("recipe_boxes").update(boxId, {
    "subscribers-": user.id,
  });
}

export async function uploadRecipes(boxId: BoxId, user: UserEntry) {
  const fileHandles = await (window as unknown as { showOpenFilePicker: (opts: { multiple: boolean }) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
    multiple: true,
  });
  for (const fh of fileHandles) {
    fh.getFile().then((f: File) => {
      f.text().then((text: string) => {
        const jsonobj = JSON.parse(text) as Recipe;
        const recipe = new RecipeEntry(
          jsonobj,
          [user.id],
          Visibility.private,
          user.id,
          "placeholder",
          new Date(),
          new Date(),
          user.id,
        );
        addRecipe(boxId, recipe);
      });
    });
  }
}

export async function addRecipe(boxId: BoxId, recipe: RecipeEntry) {
  const record = await pb().collection("recipes").create({
    box: boxId,
    data: recipe.data,
    owners: recipe.owners,
    visibility: recipe.visibility,
    creator: recipe.creator || recipe.owners[0],
    last_updated_by: recipe.lastUpdatedBy || recipe.owners[0],
    enrichment_status: recipe.enrichmentStatus || EnrichmentStatus.needed,
    ...(recipe.pendingChanges ? { pending_changes: recipe.pendingChanges } : {}),
    ...(recipe.stepIngredients ? { step_ingredients: recipe.stepIngredients } : {}),
    ...(recipe.cookingLog && recipe.cookingLog.length > 0 ? { cooking_log: recipe.cookingLog } : {}),
  });
  return { id: record.id };
}

export async function addBox(user: UserEntry, name: string) {
  if (user === null) {
    return undefined;
  }
  const record = await pb().collection("recipe_boxes").create({
    name,
    owners: [user.id],
    visibility: Visibility.private,
    creator: user.id,
    last_updated_by: user.id,
  });
  // Add box to user's recipe_boxes list
  const userRecord = await pb().collection("users").getOne(user.id);
  const boxes: string[] = userRecord.recipe_boxes || [];
  await pb().collection("users").update(user.id, {
    recipe_boxes: [...boxes, record.id],
  });
  return { id: record.id };
}

export async function deleteRecipe(boxes: Map<string, BoxEntry>, boxId: BoxId, recipeId: RecipeId, dispatch: React.Dispatch<ActionType>) {
  if (recipeId.startsWith("uniqueId=")) {
    const box = boxes.get(boxId);
    if (box !== undefined) {
      box.recipes.delete(recipeId);
    }
  } else {
    dispatch({ type: "REMOVE_RECIPE", boxId, recipeId });
    await pb().collection("recipes").delete(recipeId);
  }
}

export async function saveRecipe(boxId: BoxId, recipeId: RecipeId, recipe: RecipeEntry) {
  // Reset enrichment status so the recipe gets re-enriched after user edits
  recipe.enrichmentStatus = EnrichmentStatus.needed;
  recipe.pendingChanges = undefined;
  await pb().collection("recipes").update(recipeId, {
    data: recipe.data,
    owners: recipe.owners,
    visibility: recipe.visibility,
    last_updated_by: recipe.lastUpdatedBy,
    enrichment_status: EnrichmentStatus.needed,
    pending_changes: null,
  });
  return { id: recipeId };
}

export async function deleteBox(boxId: BoxId, dispatch: React.Dispatch<ActionType>) {
  dispatch({ type: "REMOVE_BOX", boxId });
  await pb().collection("recipe_boxes").delete(boxId);
}

export async function setBoxVisibility(boxId: BoxId, visibility: Visibility) {
  await pb().collection("recipe_boxes").update(boxId, { visibility });
}

export async function setRecipeVisibility(boxId: BoxId, recipeId: RecipeId, visibility: Visibility) {
  await pb().collection("recipes").update(recipeId, { visibility });
}

export async function setCookingModeSeen(userId: UserId) {
  await pb().collection("users").update(userId, { cooking_mode_seen: true });
}

export async function setLastSeenUpdateVersion(userId: UserId, version: number) {
  await pb().collection("users").update(userId, { last_seen_update_version: version });
}

// ============================================
// Pending Changes (generic apply/reject)
// ============================================

import type { PendingChanges } from './types';

export async function applyChanges(
  boxId: BoxId,
  recipeId: RecipeId,
  changes: PendingChanges,
  currentRecipe?: { description?: string; tags?: string[] }
) {
  // Get current recipe data
  const record = await pb().collection("recipes").getOne(recipeId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = { ...(record.data as Record<string, any>) };

  // Apply recipe data changes
  if (changes.data) {
    if (changes.data.name) {
      data.name = changes.data.name;
    }
    if (changes.data.description) {
      const currentDescription = currentRecipe?.description;
      if (changes.source === 'modification' || !currentDescription?.trim()) {
        data.description = changes.data.description;
      }
    }
    if (changes.data.recipeIngredient) {
      data.recipeIngredient = changes.data.recipeIngredient;
    }
    if (changes.data.recipeInstructions) {
      data.recipeInstructions = changes.data.recipeInstructions;
    }
    if (changes.data.recipeCategory) {
      const currentTags = currentRecipe?.tags || [];
      const existingTags = Array.isArray(currentTags) ? currentTags : [currentTags].filter(Boolean);
      const mergedTags = [...new Set([...existingTags, ...changes.data.recipeCategory].map(t => t.toLowerCase()))];
      data.recipeCategory = mergedTags;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {
    data,
    pending_changes: null,
  };

  // Apply document-level changes
  if (changes.stepIngredients && Object.keys(changes.stepIngredients).length > 0) {
    updates.step_ingredients = changes.stepIngredients;
  }

  // Set enrichment status based on source
  if (changes.source === 'enrichment') {
    updates.enrichment_status = EnrichmentStatus.done;
  } else {
    // Re-enrich after modification
    updates.enrichment_status = EnrichmentStatus.needed;
  }

  await pb().collection("recipes").update(recipeId, updates);
}

export async function rejectChanges(boxId: BoxId, recipeId: RecipeId, source?: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {
    pending_changes: null,
  };
  if (source === 'enrichment') {
    updates.enrichment_status = EnrichmentStatus.skipped;
  }
  await pb().collection("recipes").update(recipeId, updates);
}

// ============================================
// Event-based Cooking Log (recipe_events collection)
// ============================================

/**
 * Get all cooking log events for a recipe
 */
export async function getCookingLogEvents(
  boxId: BoxId,
  recipeId: RecipeId
): Promise<Event[]> {
  try {
    const records = await pb().collection("recipe_events").getFullList({
      filter: `box = "${boxId}" && subject_id = "${recipeId}"`,
      sort: "-timestamp",
    });
    return records.map((r: RecordModel) => eventFromStore(r.id, {
      subject_id: r.subject_id,
      timestamp: r.timestamp,
      created_by: r.created_by,
      data: r.data || {},
      created: r.created,
    }));
  } catch (e) {
    console.error("Failed to fetch cooking log events:", e);
    return [];
  }
}

/**
 * Add a new cooking log event
 */
export async function addCookingLogEvent(
  boxId: BoxId,
  recipeId: RecipeId,
  userId: string,
  notes?: string
): Promise<string> {
  const record = await pb().collection("recipe_events").create({
    box: boxId,
    subject_id: recipeId,
    timestamp: new Date().toISOString(),
    created_by: userId,
    data: notes ? { notes } : {},
  });
  return record.id;
}

/**
 * Update a cooking log event's notes
 */
export async function updateCookingLogEvent(
  boxId: BoxId,
  eventId: string,
  notes: string
): Promise<void> {
  const record = await pb().collection("recipe_events").getOne(eventId);
  const data = { ...(record.data || {}) };
  const trimmed = notes.trim();
  if (trimmed) {
    data.notes = trimmed;
  } else {
    delete data.notes;
  }
  await pb().collection("recipe_events").update(eventId, { data });
}

/**
 * Delete a cooking log event
 */
export async function deleteCookingLogEvent(
  boxId: BoxId,
  eventId: string
): Promise<void> {
  await pb().collection("recipe_events").delete(eventId);
}
