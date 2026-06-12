/**
 * PocketBase implementation of RecipesBackend.
 *
 * Writes route through the optimistic wrapper. Subscriptions ride on the
 * PBMirror: subscribeToUser composes a user-record slice with a dynamic
 * per-box slice set (one box-record watch + one recipes-filter watch per
 * subscribed box). When the user's `recipe_boxes` field changes, the
 * outer watch diffs against the current per-box watches and adds/removes
 * mirror handles accordingly. subscribeToCookingLog is a single
 * filter-only-wildcard slice on recipe_events.
 *
 * The legacy implementation hand-rolled three races (initial-load batch,
 * cancel-before-resolve on every inner subscribe, recipe-box-change ghost
 * when a recipe moved between boxes). All three retire here:
 *   - the mirror delivers full state per slice, no batch dance
 *   - WatchHandle.unsubscribe is synchronous & safe pre-bootstrap
 *   - per-box predicate (`r.box === boxId`) re-runs on every state
 *     change, so a recipe whose `box` changes naturally disappears from
 *     its old slice and appears in the new one — no ghost
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { RecipesBackend, RecipesUser } from "../interfaces/recipes";
import type { RecipeBox, Recipe, RecipeData, PendingChanges, CookingLogEvent } from "../types/recipes";
import type { Visibility, Unsubscribe } from "../types/common";
import type { LifeEntry } from "../types/life";
import { newId } from "../wrapped-pb/ids";
import type { WrappedPocketBase } from "../wrapped-pb";
import type { PBMirror, RawRecord, WatchHandle } from "../wrapped-pb/mirror";

/**
 * Defensive parser for the post-migration recipe_events.entries column.
 * Same shape as task_events / life_events.
 */
function entriesFromRecord(r: RecordModel | RawRecord): LifeEntry[] {
  const x = r as Record<string, unknown>;
  const raw = Array.isArray(x.entries) ? x.entries : [];
  const out: LifeEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.name !== "string") continue;
    if (e.type === "text" && typeof e.value === "string") {
      out.push({ name: e.name, type: "text", value: e.value });
    } else if (e.type === "number" && typeof e.value === "number" && typeof e.unit === "string") {
      const entry: LifeEntry = { name: e.name, type: "number", value: e.value, unit: e.unit };
      if (typeof e.scale === "number") entry.scale = e.scale;
      out.push(entry);
    } else if (e.type === "bool" && typeof e.value === "boolean") {
      out.push({ name: e.name, type: "bool", value: e.value });
    }
  }
  return out;
}

function labelsFromRecord(r: RecordModel | RawRecord): Record<string, string> | undefined {
  const x = r as Record<string, unknown>;
  return x.labels && typeof x.labels === "object" && !Array.isArray(x.labels)
    ? (x.labels as Record<string, string>)
    : undefined;
}

function notesEntries(notes?: string): LifeEntry[] {
  const trimmed = notes?.trim();
  return trimmed ? [{ name: "notes", type: "text", value: trimmed }] : [];
}

/** Cooking-log rating: stored as a number entry `{name:"rating", value, unit:"stars"}`. */
function ratingEntries(rating?: number | null): LifeEntry[] {
  if (rating === undefined || rating === null) return [];
  assertValidRating(rating);
  return [{ name: "rating", type: "number", value: rating, unit: "stars" }];
}

function assertValidRating(rating: number): void {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error(`rating must be an integer between 1 and 5, got ${rating}`);
  }
}

/** Derive the 1–5 rating from a row's entries[]; out-of-range legacy junk → undefined. */
function ratingFromEntries(entries: LifeEntry[]): number | undefined {
  for (const e of entries) {
    if (e.name === "rating" && e.type === "number" && Number.isInteger(e.value) && e.value >= 1 && e.value <= 5) {
      return e.value;
    }
  }
  return undefined;
}

// --- Record → domain type mappers ---

function userFromRecord(r: RecordModel | RawRecord): RecipesUser {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    boxes: (x.recipe_boxes as string[]) || [],
    lastSeenUpdateVersion: (x.last_seen_update_version as number) || 0,
  };
}

function boxFromRecord(r: RecordModel | RawRecord): RecipeBox {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    name: (x.name as string) || "",
    description: (x.description as string) || "",
    owners: Array.isArray(x.owners) ? (x.owners as string[]) : [],
    subscribers: Array.isArray(x.subscribers) ? (x.subscribers as string[]) : [],
    visibility: (x.visibility as RecipeBox["visibility"]) || "private",
    created: x.created as string,
    updated: x.updated as string,
    creator: (x.creator as string) || "",
    lastUpdatedBy: (x.last_updated_by as string) || "",
  };
}

function recipeFromRecord(r: RecordModel | RawRecord): Recipe {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    box: x.box as string,
    data: (x.data || {}) as RecipeData,
    owners: Array.isArray(x.owners) ? (x.owners as string[]) : [],
    visibility: (x.visibility as Recipe["visibility"]) || "private",
    enrichmentStatus: (x.enrichment_status as Recipe["enrichmentStatus"]) || "needed",
    pendingChanges: (x.pending_changes as Recipe["pendingChanges"]) || null,
    stepIngredients: (x.step_ingredients as Recipe["stepIngredients"]) || null,
    created: x.created as string,
    updated: x.updated as string,
    creator: (x.creator as string) || "",
    lastUpdatedBy: (x.last_updated_by as string) || "",
  };
}

function snapshotFromRecord(r: RecordModel | RawRecord): RecipeData | undefined {
  const x = r as Record<string, unknown>;
  const raw = x.recipe_snapshot;
  // Treat empty objects as "no snapshot" so legacy rows (PB defaults missing
  // JSON columns to {}) don't look like an empty recipe in the diff UI.
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length > 0) {
    return raw as RecipeData;
  }
  return undefined;
}

function eventFromRecord(r: RecordModel | RawRecord): CookingLogEvent {
  const x = r as Record<string, unknown>;
  const entries = entriesFromRecord(r);
  return {
    id: r.id,
    subjectId: x.subject_id as string,
    timestamp: new Date(x.timestamp as string),
    endTime: x.end_time ? new Date(x.end_time as string) : undefined,
    entries,
    rating: ratingFromEntries(entries),
    labels: labelsFromRecord(r),
    recipeSnapshot: snapshotFromRecord(r),
    createdBy: (x.created_by as string) || "",
    created: x.created as string,
    updated: x.updated as string,
  };
}

export class PocketBaseRecipesBackend implements RecipesBackend {
  private wpb: WrappedPocketBase;
  private mirror: PBMirror;

  constructor(private pb: () => PocketBase, wpb: WrappedPocketBase, mirror: PBMirror) {
    this.wpb = wpb;
    this.mirror = mirror;
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

  async addCookingLogEvent(boxId: string, recipeId: string, userId: string, options?: { notes?: string; rating?: number; timestamp?: Date }): Promise<string> {
    const id = newId();
    // Validate up front so a bad rating fails before any write is queued.
    const ratingEntry = ratingEntries(options?.rating);
    // Snapshot the recipe.data at cook time so the UI can later diff it
    // against the live recipe. Prefer the wpb cache (already populated by
    // an active recipes subscription) to avoid a round-trip; fall back to
    // a fresh getOne when not cached. If both fail, persist without a
    // snapshot rather than blocking the "I made it!" write — losing a
    // snapshot is preferable to losing the cook event.
    let snapshot: RecipeData | undefined;
    const cached = this.wpb.collection("recipes").view<{ data?: RecipeData }>(recipeId);
    if (cached?.data) {
      snapshot = cached.data;
    } else {
      try {
        const r = await this.pb().collection("recipes").getOne(recipeId);
        const data = (r as unknown as { data?: RecipeData }).data;
        if (data && typeof data === "object") snapshot = data;
      } catch {
        snapshot = undefined;
      }
    }
    await this.wpb.collection("recipe_events").create({
      id,
      box: boxId,
      subject_id: recipeId,
      timestamp: (options?.timestamp ?? new Date()).toISOString(),
      created_by: userId,
      entries: [...notesEntries(options?.notes), ...ratingEntry],
      recipe_snapshot: snapshot ?? null,
    });
    return id;
  }

  async updateCookingLogEvent(eventId: string, updates: { notes?: string; rating?: number | null }): Promise<void> {
    // Validate up front so a bad rating fails before the read.
    if (typeof updates.rating === "number") assertValidRating(updates.rating);
    const record = await this.pb().collection("recipe_events").getOne(eventId);
    // Replace only the entries being edited, preserve any others.
    let entries = entriesFromRecord(record);
    if (updates.notes !== undefined) {
      entries = [
        ...entries.filter((e) => !(e.name === "notes" && e.type === "text")),
        ...notesEntries(updates.notes),
      ];
    }
    if (updates.rating !== undefined) {
      entries = [
        ...entries.filter((e) => !(e.name === "rating" && e.type === "number")),
        ...ratingEntries(updates.rating),
      ];
    }
    await this.wpb.collection("recipe_events").update(eventId, { entries });
  }

  async deleteCookingLogEvent(eventId: string): Promise<void> {
    await this.wpb.collection("recipe_events").delete(eventId);
  }

  // --- Subscriptions ---

  subscribeToCookingLog(
    boxId: string,
    recipeId: string,
    onEvents: (events: CookingLogEvent[]) => void,
  ): Unsubscribe {
    // Filter-only wildcard slice on recipe_events scoped to (box, recipe).
    // UI still wants newest-first.
    const handle = this.mirror.watch(
      {
        collection: "recipe_events",
        topic: "*",
        filter: this.pb().filter("box = {:boxId} && subject_id = {:recipeId}", { boxId, recipeId }),
        predicate: (r) => r.box === boxId && r.subject_id === recipeId,
      },
      (records) => {
        const list = records
          .map(eventFromRecord)
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        onEvents(list);
      },
    );
    return () => handle.unsubscribe();
  }

  subscribeToUser(
    userId: string,
    handlers: {
      onUser: (user: RecipesUser) => void;
      onBox: (box: RecipeBox, recipes: Recipe[]) => void;
      onBoxRemoved: (boxId: string) => void;
      onRecipes: (boxId: string, recipes: Recipe[]) => void;
    },
  ): Unsubscribe {
    // Dynamic per-box slice set. The user-record watch is the driver:
    // every time `recipe_boxes` changes, diff against the active per-box
    // watches and add/remove handles accordingly.
    //
    // Each per-box entry holds two mirror handles: the box record and
    // the recipes filter. We track whether the initial `onBox` has been
    // emitted so we can deliver the box + first recipe batch together
    // (matching prior behavior). Subsequent emits go through `onRecipes`
    // (for recipe-side changes) and `onBox` (for box metadata changes).
    interface BoxSlice {
      handles: WatchHandle[];
      initialBoxEmitted: boolean;
      lastBox: RecipeBox | null;
      lastRecipes: Recipe[];
      hasInitialBox: boolean;
      hasInitialRecipes: boolean;
    }
    const boxSlices = new Map<string, BoxSlice>();

    const tryEmitInitial = (boxId: string) => {
      const s = boxSlices.get(boxId);
      if (!s || s.initialBoxEmitted) return;
      if (!s.hasInitialBox || !s.hasInitialRecipes) return;
      if (!s.lastBox) return;
      s.initialBoxEmitted = true;
      handlers.onBox(s.lastBox, s.lastRecipes);
    };

    const setupBox = (boxId: string): void => {
      if (boxSlices.has(boxId)) return;
      const slice: BoxSlice = {
        handles: [],
        initialBoxEmitted: false,
        lastBox: null,
        lastRecipes: [],
        hasInitialBox: false,
        hasInitialRecipes: false,
      };
      boxSlices.set(boxId, slice);

      slice.handles.push(this.mirror.watch(
        { collection: "recipe_boxes", topic: boxId },
        (records) => {
          if (records.length === 0) {
            // The box was deleted (or never existed). The mirror emits
            // empty for both cases; if we'd previously seen the box,
            // surface the removal so the consumer drops it.
            if (slice.lastBox) handlers.onBoxRemoved(boxId);
            return;
          }
          const box = boxFromRecord(records[0]);
          slice.lastBox = box;
          slice.hasInitialBox = true;
          if (!slice.initialBoxEmitted) {
            tryEmitInitial(boxId);
          } else {
            // Post-initial: surface metadata changes by re-emitting onBox
            // with the current known recipes. Consumers treat this as a
            // box-fields update.
            handlers.onBox(box, slice.lastRecipes);
          }
        },
      ));

      slice.handles.push(this.mirror.watch(
        {
          collection: "recipes",
          topic: "*",
          filter: this.pb().filter("box = {:boxId}", { boxId }),
          predicate: (r) => r.box === boxId,
        },
        (records) => {
          const recipes = records.map(recipeFromRecord);
          slice.lastRecipes = recipes;
          slice.hasInitialRecipes = true;
          if (!slice.initialBoxEmitted) {
            tryEmitInitial(boxId);
          } else {
            handlers.onRecipes(boxId, recipes);
          }
        },
      ));
    };

    const teardownBox = (boxId: string): void => {
      const s = boxSlices.get(boxId);
      if (!s) return;
      for (const h of s.handles) h.unsubscribe();
      boxSlices.delete(boxId);
    };

    const userHandle = this.mirror.watch(
      { collection: "users", topic: userId },
      (records) => {
        if (records.length === 0) return;
        const user = userFromRecord(records[0]);
        handlers.onUser(user);

        const currentBoxes = new Set(user.boxes);
        // Tear down boxes no longer in the user's set.
        for (const boxId of Array.from(boxSlices.keys())) {
          if (!currentBoxes.has(boxId)) teardownBox(boxId);
        }
        // Set up boxes newly in the set.
        for (const boxId of user.boxes) setupBox(boxId);
      },
    );

    return () => {
      userHandle.unsubscribe();
      for (const boxId of Array.from(boxSlices.keys())) teardownBox(boxId);
    };
  }
}
