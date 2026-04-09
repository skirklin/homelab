/**
 * PocketBase implementation of RecipesBackend.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { RecipesBackend, RecipesUser } from "../interfaces/recipes";
import type { RecipeBox, Recipe, RecipeData, PendingChanges, CookingLogEvent } from "../types/recipes";
import type { Visibility, Unsubscribe, Event } from "../types/common";

// --- Record → domain type mappers ---

function userFromRecord(r: RecordModel): RecipesUser {
  return {
    id: r.id,
    boxes: r.recipe_boxes || [],
    cookingModeSeen: !!r.cooking_mode_seen,
    lastSeenUpdateVersion: r.last_seen_update_version || 0,
  };
}

function boxFromRecord(r: RecordModel): RecipeBox {
  return {
    id: r.id,
    name: r.name || "",
    description: r.description || "",
    owners: Array.isArray(r.owners) ? r.owners : [],
    subscribers: Array.isArray(r.subscribers) ? r.subscribers : [],
    visibility: r.visibility || "private",
    created: r.created,
    updated: r.updated,
    creator: r.creator || "",
    lastUpdatedBy: r.last_updated_by || "",
  };
}

function recipeFromRecord(r: RecordModel): Recipe {
  return {
    id: r.id,
    box: r.box,
    data: (r.data || {}) as RecipeData,
    owners: Array.isArray(r.owners) ? r.owners : [],
    visibility: r.visibility || "private",
    enrichmentStatus: r.enrichment_status || "needed",
    pendingChanges: r.pending_changes || null,
    stepIngredients: r.step_ingredients || null,
    cookingLog: r.cooking_log || null,
    created: r.created,
    updated: r.updated,
    creator: r.creator || "",
    lastUpdatedBy: r.last_updated_by || "",
  };
}

function eventFromRecord(r: RecordModel): CookingLogEvent {
  return {
    id: r.id,
    subjectId: r.subject_id,
    timestamp: new Date(r.timestamp),
    createdAt: new Date(r.created),
    createdBy: r.created_by || "",
    data: r.data || {},
  };
}

export class PocketBaseRecipesBackend implements RecipesBackend {
  constructor(private pb: () => PocketBase) {}

  // --- User ---

  async getUser(userId: string): Promise<RecipesUser | null> {
    try {
      const r = await this.pb().collection("users").getOne(userId);
      return userFromRecord(r);
    } catch {
      return null;
    }
  }

  async setCookingModeSeen(userId: string): Promise<void> {
    await this.pb().collection("users").update(userId, { cooking_mode_seen: true });
  }

  async setLastSeenUpdateVersion(userId: string, version: number): Promise<void> {
    await this.pb().collection("users").update(userId, { last_seen_update_version: version });
  }

  // --- Box CRUD ---

  async createBox(userId: string, name: string): Promise<string> {
    const record = await this.pb().collection("recipe_boxes").create({
      name,
      owners: [userId],
      visibility: "private",
      creator: userId,
      last_updated_by: userId,
    });
    // Add to user's recipe_boxes list
    const userRecord = await this.pb().collection("users").getOne(userId);
    const boxes: string[] = userRecord.recipe_boxes || [];
    if (!boxes.includes(record.id)) {
      await this.pb().collection("users").update(userId, {
        recipe_boxes: [...boxes, record.id],
      });
    }
    return record.id;
  }

  async deleteBox(boxId: string): Promise<void> {
    await this.pb().collection("recipe_boxes").delete(boxId);
  }

  async setBoxVisibility(boxId: string, visibility: Visibility): Promise<void> {
    await this.pb().collection("recipe_boxes").update(boxId, { visibility });
  }

  async subscribeToBox(userId: string, boxId: string): Promise<void> {
    const userRecord = await this.pb().collection("users").getOne(userId);
    const boxes: string[] = userRecord.recipe_boxes || [];
    if (!boxes.includes(boxId)) {
      await this.pb().collection("users").update(userId, {
        recipe_boxes: [...boxes, boxId],
      });
    }
    await this.pb().collection("recipe_boxes").update(boxId, {
      "subscribers+": userId,
    });
  }

  async unsubscribeFromBox(userId: string, boxId: string): Promise<void> {
    const userRecord = await this.pb().collection("users").getOne(userId);
    const boxes: string[] = userRecord.recipe_boxes || [];
    await this.pb().collection("users").update(userId, {
      recipe_boxes: boxes.filter((b: string) => b !== boxId),
    });
    await this.pb().collection("recipe_boxes").update(boxId, {
      "subscribers-": userId,
    });
  }

  // --- Recipe CRUD ---

  async getBox(boxId: string, userId: string | null): Promise<{ box: RecipeBox; recipes: Recipe[] } | null> {
    try {
      const record = await this.pb().collection("recipe_boxes").getOne(boxId);
      const box = boxFromRecord(record);
      const recipes: Recipe[] = [];
      if (userId) {
        const records = await this.pb().collection("recipes").getFullList({
          filter: this.pb().filter("box = {:boxId}", { boxId }),
        });
        for (const r of records) recipes.push(recipeFromRecord(r));
      }
      return { box, recipes };
    } catch {
      return null;
    }
  }

  async addRecipe(boxId: string, data: RecipeData, userId: string): Promise<string> {
    const record = await this.pb().collection("recipes").create({
      box: boxId,
      data,
      owners: [userId],
      visibility: "private",
      creator: userId,
      last_updated_by: userId,
      enrichment_status: "needed",
    });
    return record.id;
  }

  async saveRecipe(recipeId: string, data: RecipeData, userId: string): Promise<void> {
    await this.pb().collection("recipes").update(recipeId, {
      data,
      last_updated_by: userId,
      enrichment_status: "needed",
      pending_changes: null,
    });
  }

  async deleteRecipe(recipeId: string): Promise<void> {
    await this.pb().collection("recipes").delete(recipeId);
  }

  async setRecipeVisibility(recipeId: string, visibility: Visibility): Promise<void> {
    await this.pb().collection("recipes").update(recipeId, { visibility });
  }

  // --- Enrichment ---

  async applyChanges(
    recipeId: string,
    changes: PendingChanges,
    currentRecipe?: { description?: string; tags?: string[] },
  ): Promise<void> {
    const record = await this.pb().collection("recipes").getOne(recipeId);
    const data = { ...(record.data as Record<string, unknown>) };

    if (changes.data) {
      if (changes.data.name) data.name = changes.data.name;
      if (changes.data.description) {
        if (changes.source === "modification" || !currentRecipe?.description?.trim()) {
          data.description = changes.data.description;
        }
      }
      if (changes.data.recipeIngredient) data.recipeIngredient = changes.data.recipeIngredient;
      if (changes.data.recipeInstructions) data.recipeInstructions = changes.data.recipeInstructions;
      if (changes.data.recipeCategory) {
        const existing = currentRecipe?.tags || [];
        const merged = [...new Set([...existing, ...changes.data.recipeCategory].map((t) => t.toLowerCase()))];
        data.recipeCategory = merged;
      }
    }

    const updates: Record<string, unknown> = { data, pending_changes: null };
    if (changes.stepIngredients && Object.keys(changes.stepIngredients).length > 0) {
      updates.step_ingredients = changes.stepIngredients;
    }
    updates.enrichment_status = changes.source === "enrichment" ? "done" : "needed";

    await this.pb().collection("recipes").update(recipeId, updates);
  }

  async rejectChanges(recipeId: string, source?: string): Promise<void> {
    const updates: Record<string, unknown> = { pending_changes: null };
    if (source === "enrichment") updates.enrichment_status = "skipped";
    await this.pb().collection("recipes").update(recipeId, updates);
  }

  // --- Cooking log ---

  async getCookingLogEvents(boxId: string, recipeId: string): Promise<CookingLogEvent[]> {
    try {
      const records = await this.pb().collection("recipe_events").getFullList({
        filter: this.pb().filter("box = {:boxId} && subject_id = {:recipeId}", { boxId, recipeId }),
        sort: "-timestamp",
      });
      return records.map(eventFromRecord);
    } catch {
      return [];
    }
  }

  async addCookingLogEvent(boxId: string, recipeId: string, userId: string, options?: { notes?: string; timestamp?: Date }): Promise<string> {
    const record = await this.pb().collection("recipe_events").create({
      box: boxId,
      subject_id: recipeId,
      timestamp: (options?.timestamp ?? new Date()).toISOString(),
      created_by: userId,
      data: options?.notes ? { notes: options.notes } : {},
    });
    return record.id;
  }

  async updateCookingLogEvent(eventId: string, notes: string): Promise<void> {
    const record = await this.pb().collection("recipe_events").getOne(eventId);
    const data = { ...(record.data || {}) };
    const trimmed = notes.trim();
    if (trimmed) {
      data.notes = trimmed;
    } else {
      delete data.notes;
    }
    await this.pb().collection("recipe_events").update(eventId, { data });
  }

  async deleteCookingLogEvent(eventId: string): Promise<void> {
    await this.pb().collection("recipe_events").delete(eventId);
  }

  // --- Subscriptions ---

  subscribeToUser(
    userId: string,
    handlers: {
      onUser: (user: RecipesUser) => void;
      onBox: (box: RecipeBox, recipes: Recipe[]) => void;
      onBoxRemoved: (boxId: string) => void;
      onRecipeChanged: (boxId: string, recipe: Recipe) => void;
      onRecipeRemoved: (boxId: string, recipeId: string) => void;
    },
  ): Unsubscribe {
    let cancelled = false;
    const isCancelled = () => cancelled;
    const boxUnsubs = new Map<string, Array<() => void>>();

    const setupBox = async (boxId: string) => {
      if (cancelled || boxUnsubs.has(boxId)) return;
      const unsubs: Array<() => void> = [];
      boxUnsubs.set(boxId, unsubs);

      // Subscribe to box record
      try {
        const boxRecord = await this.pb().collection("recipe_boxes").getOne(boxId, { $autoCancel: false });
        if (cancelled) return;
        const box = boxFromRecord(boxRecord);

        // Fetch recipes for this box
        const recipeRecords = await this.pb().collection("recipes").getFullList({
          filter: this.pb().filter("box = {:boxId}", { boxId }),
          $autoCancel: false,
        });
        if (cancelled) return;
        const recipes = recipeRecords.map(recipeFromRecord);
        handlers.onBox(box, recipes);
      } catch {
        // Box may not exist
        return;
      }

      // Box realtime
      this.pb().collection("recipe_boxes").subscribe(boxId, (e) => {
        if (cancelled) return;
        if (e.action === "delete") {
          handlers.onBoxRemoved(boxId);
        } else {
          const box = boxFromRecord(e.record);
          handlers.onBox(box, []); // recipes unchanged
        }
      }).then((unsub) => unsubs.push(unsub));

      // Recipes realtime for this box
      const subKey = `box_${boxId}`;
      this.pb().collection("recipes").subscribe(subKey, (e) => {
        if (cancelled || e.record.box !== boxId) return;
        if (e.action === "delete") {
          handlers.onRecipeRemoved(boxId, e.record.id);
        } else {
          handlers.onRecipeChanged(boxId, recipeFromRecord(e.record));
        }
      }).then((unsub) => unsubs.push(unsub));
    };

    // Subscribe to user record for box list changes
    let userUnsub: (() => void) | undefined;

    const initUser = async () => {
      try {
        const userRecord = await this.pb().collection("users").getOne(userId, { $autoCancel: false });
        if (cancelled) return;
        const user = userFromRecord(userRecord);
        handlers.onUser(user);

        for (const boxId of user.boxes) {
          setupBox(boxId);
        }
      } catch {
        // User not found
      }

      this.pb().collection("users").subscribe(userId, (e) => {
        if (cancelled) return;
        const user = userFromRecord(e.record);
        handlers.onUser(user);

        // Tear down subscriptions for boxes no longer in the user's list
        const currentBoxes = new Set(user.boxes);
        for (const [boxId, unsubs] of boxUnsubs) {
          if (!currentBoxes.has(boxId)) {
            unsubs.forEach((u) => u());
            boxUnsubs.delete(boxId);
          }
        }

        for (const boxId of user.boxes) {
          setupBox(boxId);
        }
      }).then((fn) => { userUnsub = fn; });
    };

    initUser();

    return () => {
      cancelled = true;
      userUnsub?.();
      for (const unsubs of boxUnsubs.values()) {
        unsubs.forEach((u) => u());
      }
      boxUnsubs.clear();
    };
  }
}
