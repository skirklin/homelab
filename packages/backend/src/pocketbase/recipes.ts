/**
 * PocketBase implementation of RecipesBackend.
 *
 * Writes route through the optimistic wrapper. Per-box subscriptions
 * (recipe_boxes record + recipes filtered by box) use wpb so optimistic
 * mutations fan to the right box.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { RecipesBackend, RecipesUser } from "../interfaces/recipes";
import type { RecipeBox, Recipe, RecipeData, PendingChanges, CookingLogEvent } from "../types/recipes";
import type { Visibility, Unsubscribe, Event } from "../types/common";
import { newId } from "../cache/ids";
import { wrapPocketBase, type WrappedPocketBase } from "../wrapped-pb";

// --- Record → domain type mappers ---

function userFromRecord(r: RecordModel): RecipesUser {
  return {
    id: r.id,
    boxes: r.recipe_boxes || [],
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
  private wpb: WrappedPocketBase;

  constructor(private pb: () => PocketBase, wpb?: WrappedPocketBase) {
    this.wpb = wpb ?? wrapPocketBase(pb);
  }

  // --- User ---

  async getUser(userId: string): Promise<RecipesUser | null> {
    try {
      const r = await this.pb().collection("users").getOne(userId);
      return userFromRecord(r);
    } catch {
      return null;
    }
  }

  async setLastSeenUpdateVersion(userId: string, version: number): Promise<void> {
    await this.wpb.collection("users").update(userId, { last_seen_update_version: version });
  }

  // --- Box CRUD ---

  async createBox(userId: string, name: string): Promise<string> {
    const id = newId();
    const boxes = await this.readUserBoxes(userId);
    // Box create + user-list append fire in parallel.
    await Promise.all([
      this.wpb.collection("recipe_boxes").create({
        id,
        name,
        owners: [userId],
        visibility: "private",
        creator: userId,
        last_updated_by: userId,
      }),
      boxes.includes(id)
        ? Promise.resolve()
        : this.wpb.collection("users").update(userId, { recipe_boxes: [...boxes, id] }),
    ]);
    return id;
  }

  /**
   * Read the user's `recipe_boxes` JSON field. Prefer the wpb cache (already
   * populated by an active user subscription) to avoid a network round-trip;
   * fall back to a fresh getOne if not cached.
   */
  private async readUserBoxes(userId: string): Promise<string[]> {
    const cached = this.wpb.collection("users").view<{ recipe_boxes?: string[] }>(userId);
    if (cached) return cached.recipe_boxes || [];
    const user = await this.pb().collection("users").getOne(userId);
    return user.recipe_boxes || [];
  }

  async deleteBox(boxId: string): Promise<void> {
    await this.wpb.collection("recipe_boxes").delete(boxId);
  }

  async setBoxVisibility(boxId: string, visibility: Visibility): Promise<void> {
    await this.wpb.collection("recipe_boxes").update(boxId, { visibility });
  }

  async subscribeToBox(userId: string, boxId: string): Promise<void> {
    const boxes = await this.readUserBoxes(userId);
    await Promise.all([
      boxes.includes(boxId)
        ? Promise.resolve()
        : this.wpb.collection("users").update(userId, { recipe_boxes: [...boxes, boxId] }),
      // `subscribers` is a real relation field — atomic `+=` works.
      this.wpb.collection("recipe_boxes").update(boxId, { "subscribers+": userId }),
    ]);
  }

  async unsubscribeFromBox(userId: string, boxId: string): Promise<void> {
    const boxes = await this.readUserBoxes(userId);
    await Promise.all([
      this.wpb.collection("users").update(userId, {
        recipe_boxes: boxes.filter((b) => b !== boxId),
      }),
      this.wpb.collection("recipe_boxes").update(boxId, { "subscribers-": userId }),
    ]);
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
    const id = newId();
    await this.wpb.collection("recipes").create({
      id,
      box: boxId,
      data,
      owners: [userId],
      visibility: "private",
      creator: userId,
      last_updated_by: userId,
      enrichment_status: "needed",
    });
    return id;
  }

  async saveRecipe(recipeId: string, data: RecipeData, userId: string): Promise<void> {
    await this.wpb.collection("recipes").update(recipeId, {
      data,
      last_updated_by: userId,
      enrichment_status: "needed",
      pending_changes: null,
    });
  }

  async deleteRecipe(recipeId: string): Promise<void> {
    await this.wpb.collection("recipes").delete(recipeId);
  }

  async setRecipeVisibility(recipeId: string, visibility: Visibility): Promise<void> {
    await this.wpb.collection("recipes").update(recipeId, { visibility });
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

    await this.wpb.collection("recipes").update(recipeId, updates);
  }

  async rejectChanges(recipeId: string, source?: string): Promise<void> {
    const updates: Record<string, unknown> = { pending_changes: null };
    if (source === "enrichment") updates.enrichment_status = "skipped";
    await this.wpb.collection("recipes").update(recipeId, updates);
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
    const id = newId();
    await this.wpb.collection("recipe_events").create({
      id,
      box: boxId,
      subject_id: recipeId,
      timestamp: (options?.timestamp ?? new Date()).toISOString(),
      created_by: userId,
      data: options?.notes ? { notes: options.notes } : {},
    });
    return id;
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
    await this.wpb.collection("recipe_events").update(eventId, { data });
  }

  async deleteCookingLogEvent(eventId: string): Promise<void> {
    await this.wpb.collection("recipe_events").delete(eventId);
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
    const boxUnsubs = new Map<string, Array<() => void>>();

    // Buffer initial box+recipes events and emit a single combined onBox
    // call once both subscriptions have delivered their initial state. This
    // matches the prior behavior (one batched onBox(box, recipes) call) so
    // the consumer doesn't see N intermediate callbacks during initial load.
    const setupBox = (boxId: string) => {
      if (cancelled || boxUnsubs.has(boxId)) return;
      const unsubs: Array<() => void> = [];
      boxUnsubs.set(boxId, unsubs);

      let boxInitialDone = false;
      let recipesInitialDone = false;
      let initialBox: RecipeBox | null = null;
      const initialRecipes: Recipe[] = [];
      let combinedEmitted = false;

      const tryEmitInitial = () => {
        if (combinedEmitted || !boxInitialDone || !recipesInitialDone) return;
        combinedEmitted = true;
        if (initialBox) handlers.onBox(initialBox, initialRecipes);
      };

      // Box record — wpb auto-loads via getOne, delivers as a "create".
      this.wpb.collection("recipe_boxes").subscribe(boxId, (e) => {
        if (cancelled) return;
        if (e.action === "delete") {
          handlers.onBoxRemoved(boxId);
          return;
        }
        const box = boxFromRecord(e.record);
        if (!combinedEmitted) {
          initialBox = box;
          return;
        }
        handlers.onBox(box, []);
      }).then((unsub) => {
        unsubs.push(unsub);
        if (cancelled) return;
        boxInitialDone = true;
        tryEmitInitial();
      });

      // Recipes for this box — wpb auto-loads via getFullList(filter),
      // delivers each as a "create", then forwards live events.
      this.wpb.collection("recipes").subscribe("*", (e) => {
        if (cancelled || (e.record as RecordModel).box !== boxId) return;
        if (e.action === "delete") {
          handlers.onRecipeRemoved(boxId, e.record.id);
          return;
        }
        const recipe = recipeFromRecord(e.record);
        if (!combinedEmitted) {
          initialRecipes.push(recipe);
          return;
        }
        handlers.onRecipeChanged(boxId, recipe);
      }, {
        filter: this.pb().filter("box = {:boxId}", { boxId }),
        local: (r) => r.box === boxId,
      }).then((unsub) => {
        unsubs.push(unsub);
        if (cancelled) return;
        recipesInitialDone = true;
        tryEmitInitial();
      });
    };

    // User record drives the box list. wpb.subscribe(id) auto-loads and
    // delivers the user as the first "create" event, which sets up
    // per-box subscriptions; subsequent updates re-reconcile the set.
    let userUnsub: (() => void) | undefined;
    this.wpb.collection("users").subscribe(userId, (e) => {
      if (cancelled) return;
      if (e.action === "delete") return;
      const user = userFromRecord(e.record);
      handlers.onUser(user);

      const currentBoxes = new Set(user.boxes);
      for (const [boxId, unsubs] of boxUnsubs) {
        if (!currentBoxes.has(boxId)) {
          unsubs.forEach((u) => u());
          boxUnsubs.delete(boxId);
        }
      }
      for (const boxId of user.boxes) setupBox(boxId);
    }).then((fn) => { userUnsub = fn; });

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
