/**
 * Supabase implementation of RecipesBackend.
 *
 * The interesting one — visibility cascades (recipe public OR box public)
 * are enforced by RLS, so this implementation just issues queries and
 * trusts the policy layer. Anon reads of public recipes work the same way.
 *
 * Schema notes:
 *   - `recipe_boxes` and `recipe_owners` are junction tables (PB used a
 *     comma-separated relation column).
 *   - `recipe_box_subscribers` tracks the public "I follow this box" set.
 *     The PB version also stored a per-user `recipe_boxes` JSON array on
 *     the users row pointing at every box they own OR follow — we keep
 *     that shape on `user_profiles.recipe_boxes` for parity with the
 *     RecipesBackend.getUser contract.
 *   - `recipe_events.box_id + subject_id` identifies a cooking-log entry
 *     for a given recipe.
 *
 * No optimistic write layer yet — Phase 3 first cut.
 */
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { RecipesBackend, RecipesUser } from "../interfaces/recipes";
import type {
  RecipeBox,
  Recipe,
  RecipeData,
  PendingChanges,
  CookingLogEvent,
  EnrichmentStatus,
} from "../types/recipes";
import type { Visibility, Unsubscribe } from "../types/common";

// ---- Row shapes --------------------------------------------------------

interface BoxRow {
  id: string;
  name: string;
  description: string | null;
  visibility: Visibility;
  creator: string | null;
  last_updated_by: string | null;
  created_at: string;
  updated_at: string;
  recipe_box_owners?: Array<{ user_id: string }>;
  recipe_box_subscribers?: Array<{ user_id: string }>;
}

interface RecipeRow {
  id: string;
  box_id: string;
  data: RecipeData | null;
  visibility: Visibility;
  creator: string | null;
  last_updated_by: string | null;
  enrichment_status: EnrichmentStatus | null;
  pending_changes: PendingChanges | null;
  step_ingredients: Record<string, string[]> | null;
  cooking_log: unknown;
  created_at: string;
  updated_at: string;
  recipe_owners?: Array<{ user_id: string }>;
}

interface RecipeEventRow {
  id: string;
  box_id: string;
  subject_id: string;
  timestamp: string;
  created_by: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// ---- Mappers -----------------------------------------------------------

function boxFromRow(r: BoxRow): RecipeBox {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    owners: r.recipe_box_owners?.map((o) => o.user_id) ?? [],
    subscribers: r.recipe_box_subscribers?.map((s) => s.user_id) ?? [],
    visibility: r.visibility,
    created: r.created_at,
    updated: r.updated_at,
    creator: r.creator ?? "",
    lastUpdatedBy: r.last_updated_by ?? "",
  };
}

function recipeFromRow(r: RecipeRow): Recipe {
  return {
    id: r.id,
    box: r.box_id,
    data: (r.data ?? {}) as RecipeData,
    owners: r.recipe_owners?.map((o) => o.user_id) ?? [],
    visibility: r.visibility,
    enrichmentStatus: r.enrichment_status ?? "needed",
    pendingChanges: r.pending_changes,
    stepIngredients: r.step_ingredients,
    cookingLog: r.cooking_log,
    created: r.created_at,
    updated: r.updated_at,
    creator: r.creator ?? "",
    lastUpdatedBy: r.last_updated_by ?? "",
  };
}

function eventFromRow(r: RecipeEventRow): CookingLogEvent {
  return {
    id: r.id,
    subjectId: r.subject_id,
    timestamp: new Date(r.timestamp),
    createdAt: new Date(r.created_at),
    createdBy: r.created_by ?? "",
    data: r.data ?? {},
  };
}

const BOX_SELECT = "*, recipe_box_owners(user_id), recipe_box_subscribers(user_id)";
const RECIPE_SELECT = "*, recipe_owners(user_id)";

// ---- Backend impl ------------------------------------------------------

export class SupabaseRecipesBackend implements RecipesBackend {
  constructor(private client: SupabaseClient) {}

  // ----- User --------------------------------------------------------------

  async getUser(userId: string): Promise<RecipesUser | null> {
    const { data, error } = await this.client
      .from("user_profiles")
      .select("id, recipe_boxes, last_seen_update_version")
      .eq("id", userId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      id: data.id,
      boxes: Array.isArray(data.recipe_boxes) ? (data.recipe_boxes as string[]) : [],
      lastSeenUpdateVersion: data.last_seen_update_version ?? 0,
    };
  }

  async setLastSeenUpdateVersion(userId: string, version: number): Promise<void> {
    const { error } = await this.client
      .from("user_profiles")
      .upsert({ id: userId, last_seen_update_version: version }, { onConflict: "id" });
    if (error) throw error;
  }

  // ----- Box CRUD ---------------------------------------------------------

  async createBox(userId: string, name: string): Promise<string> {
    const { data: box, error: boxErr } = await this.client
      .from("recipe_boxes")
      .insert({
        name,
        visibility: "private",
        creator: userId,
        last_updated_by: userId,
      })
      .select("id")
      .single();
    if (boxErr) throw boxErr;

    const { error: ownerErr } = await this.client
      .from("recipe_box_owners")
      .insert({ box_id: box.id, user_id: userId });
    if (ownerErr) {
      await this.client.from("recipe_boxes").delete().eq("id", box.id);
      throw ownerErr;
    }

    await this.addBoxToUserList(userId, box.id);
    return box.id;
  }

  async deleteBox(boxId: string): Promise<void> {
    // Cascade handles recipes, owners, subscribers, events.
    // We don't try to scrub user_profiles.recipe_boxes lists across all
    // users — that's a Phase 3.5 cleanup. RecipesUser.boxes filtering will
    // naturally drop missing IDs.
    const { error } = await this.client.from("recipe_boxes").delete().eq("id", boxId);
    if (error) throw error;
  }

  async setBoxVisibility(boxId: string, visibility: Visibility): Promise<void> {
    const { error } = await this.client
      .from("recipe_boxes")
      .update({ visibility })
      .eq("id", boxId);
    if (error) throw error;
  }

  async subscribeToBox(userId: string, boxId: string): Promise<void> {
    const { error } = await this.client
      .from("recipe_box_subscribers")
      .upsert(
        { box_id: boxId, user_id: userId },
        { onConflict: "box_id,user_id" },
      );
    if (error) throw error;
    await this.addBoxToUserList(userId, boxId);
  }

  async unsubscribeFromBox(userId: string, boxId: string): Promise<void> {
    const { error } = await this.client
      .from("recipe_box_subscribers")
      .delete()
      .eq("box_id", boxId)
      .eq("user_id", userId);
    if (error) throw error;
    await this.removeBoxFromUserList(userId, boxId);
  }

  // ----- Recipe CRUD ------------------------------------------------------

  async getBox(
    boxId: string,
    userId: string | null,
  ): Promise<{ box: RecipeBox; recipes: Recipe[] } | null> {
    const { data: box, error: boxErr } = await this.client
      .from("recipe_boxes")
      .select(BOX_SELECT)
      .eq("id", boxId)
      .maybeSingle();
    if (boxErr || !box) return null;

    if (!userId) {
      return { box: boxFromRow(box as BoxRow), recipes: [] };
    }

    const { data: rows } = await this.client
      .from("recipes")
      .select(RECIPE_SELECT)
      .eq("box_id", boxId);
    const recipes = (rows as RecipeRow[] | null)?.map(recipeFromRow) ?? [];
    return { box: boxFromRow(box as BoxRow), recipes };
  }

  async addRecipe(boxId: string, data: RecipeData, userId: string): Promise<string> {
    const { data: row, error } = await this.client
      .from("recipes")
      .insert({
        box_id: boxId,
        data,
        visibility: "private",
        creator: userId,
        last_updated_by: userId,
        enrichment_status: "needed",
      })
      .select("id")
      .single();
    if (error) throw error;

    const { error: ownerErr } = await this.client
      .from("recipe_owners")
      .insert({ recipe_id: row.id, user_id: userId });
    if (ownerErr) {
      await this.client.from("recipes").delete().eq("id", row.id);
      throw ownerErr;
    }
    return row.id;
  }

  async saveRecipe(recipeId: string, data: RecipeData, userId: string): Promise<void> {
    const { error } = await this.client
      .from("recipes")
      .update({
        data,
        last_updated_by: userId,
        enrichment_status: "needed",
        pending_changes: null,
      })
      .eq("id", recipeId);
    if (error) throw error;
  }

  async deleteRecipe(recipeId: string): Promise<void> {
    const { error } = await this.client.from("recipes").delete().eq("id", recipeId);
    if (error) throw error;
  }

  async setRecipeVisibility(recipeId: string, visibility: Visibility): Promise<void> {
    const { error } = await this.client
      .from("recipes")
      .update({ visibility })
      .eq("id", recipeId);
    if (error) throw error;
  }

  // ----- Enrichment / pending changes ------------------------------------

  async applyChanges(
    recipeId: string,
    changes: PendingChanges,
    currentRecipe?: { description?: string; tags?: string[] },
  ): Promise<void> {
    const { data: row, error: readErr } = await this.client
      .from("recipes")
      .select("data")
      .eq("id", recipeId)
      .single();
    if (readErr) throw readErr;

    const data: Record<string, unknown> = { ...((row.data as Record<string, unknown>) ?? {}) };
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
        const existing = currentRecipe?.tags ?? [];
        const merged = [
          ...new Set(
            [...existing, ...changes.data.recipeCategory].map((t) => t.toLowerCase()),
          ),
        ];
        data.recipeCategory = merged;
      }
    }

    const patch: Record<string, unknown> = { data, pending_changes: null };
    if (changes.stepIngredients && Object.keys(changes.stepIngredients).length > 0) {
      patch.step_ingredients = changes.stepIngredients;
    }
    patch.enrichment_status = changes.source === "enrichment" ? "done" : "needed";

    const { error } = await this.client.from("recipes").update(patch).eq("id", recipeId);
    if (error) throw error;
  }

  async rejectChanges(recipeId: string, source?: string): Promise<void> {
    const patch: Record<string, unknown> = { pending_changes: null };
    if (source === "enrichment") patch.enrichment_status = "skipped";
    const { error } = await this.client.from("recipes").update(patch).eq("id", recipeId);
    if (error) throw error;
  }

  // ----- Cooking log ------------------------------------------------------

  async getCookingLogEvents(boxId: string, recipeId: string): Promise<CookingLogEvent[]> {
    const { data, error } = await this.client
      .from("recipe_events")
      .select("*")
      .eq("box_id", boxId)
      .eq("subject_id", recipeId)
      .order("timestamp", { ascending: false });
    if (error || !data) return [];
    return (data as RecipeEventRow[]).map(eventFromRow);
  }

  async addCookingLogEvent(
    boxId: string,
    recipeId: string,
    userId: string,
    options?: { notes?: string; timestamp?: Date },
  ): Promise<string> {
    const { data, error } = await this.client
      .from("recipe_events")
      .insert({
        box_id: boxId,
        subject_id: recipeId,
        timestamp: (options?.timestamp ?? new Date()).toISOString(),
        created_by: userId,
        data: options?.notes ? { notes: options.notes } : {},
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async updateCookingLogEvent(eventId: string, notes: string): Promise<void> {
    const { data: row, error: readErr } = await this.client
      .from("recipe_events")
      .select("data")
      .eq("id", eventId)
      .single();
    if (readErr) throw readErr;

    const data: Record<string, unknown> = { ...((row.data as Record<string, unknown>) ?? {}) };
    const trimmed = notes.trim();
    if (trimmed) data.notes = trimmed;
    else delete data.notes;

    const { error } = await this.client
      .from("recipe_events")
      .update({ data })
      .eq("id", eventId);
    if (error) throw error;
  }

  async deleteCookingLogEvent(eventId: string): Promise<void> {
    const { error } = await this.client.from("recipe_events").delete().eq("id", eventId);
    if (error) throw error;
  }

  // ----- Subscriptions ---------------------------------------------------

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
    const boxSubs = new Map<string, () => void>();

    const ensureBoxSub = (boxId: string) => {
      if (cancelled || boxSubs.has(boxId)) return;

      // Single channel per box, watching both recipe_boxes and recipes.
      let combinedEmitted = false;
      let initialBox: RecipeBox | null = null;
      const initialRecipes: Recipe[] = [];
      let boxInitialDone = false;
      let recipesInitialDone = false;

      const tryEmitInitial = () => {
        if (combinedEmitted || !boxInitialDone || !recipesInitialDone) return;
        combinedEmitted = true;
        if (initialBox) handlers.onBox(initialBox, initialRecipes);
      };

      const reloadBoxAndEmit = async () => {
        const { data } = await this.client
          .from("recipe_boxes")
          .select(BOX_SELECT)
          .eq("id", boxId)
          .maybeSingle();
        if (cancelled || !data) return;
        const box = boxFromRow(data as BoxRow);
        if (combinedEmitted) handlers.onBox(box, []);
        else {
          initialBox = box;
          boxInitialDone = true;
          tryEmitInitial();
        }
      };

      const reloadRecipeAndEmit = async (recipeId: string) => {
        const { data } = await this.client
          .from("recipes")
          .select(RECIPE_SELECT)
          .eq("id", recipeId)
          .maybeSingle();
        if (cancelled || !data) return;
        handlers.onRecipeChanged(boxId, recipeFromRow(data as RecipeRow));
      };

      const channel: RealtimeChannel = this.client
        .channel(`recipes-box-${boxId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "recipe_boxes", filter: `id=eq.${boxId}` },
          (payload) => {
            if (cancelled) return;
            if (payload.eventType === "DELETE") {
              handlers.onBoxRemoved(boxId);
              return;
            }
            // Re-fetch to get the owners/subscribers join.
            void reloadBoxAndEmit();
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "recipes", filter: `box_id=eq.${boxId}` },
          (payload) => {
            if (cancelled) return;
            if (payload.eventType === "DELETE") {
              const old = payload.old as Partial<RecipeRow>;
              if (old.id) handlers.onRecipeRemoved(boxId, old.id);
              return;
            }
            const newRow = payload.new as RecipeRow;
            // Re-fetch for owners join. (We could fold owners into payload by
            // listening to recipe_owners separately, but per-recipe re-fetch
            // is cheaper than maintaining a parallel cache here.)
            void reloadRecipeAndEmit(newRow.id);
          },
        )
        .subscribe(async (status) => {
          if (status !== "SUBSCRIBED" || cancelled) return;
          // Initial loads in parallel.
          const [{ data: boxData }, { data: recipeRows }] = await Promise.all([
            this.client.from("recipe_boxes").select(BOX_SELECT).eq("id", boxId).maybeSingle(),
            this.client.from("recipes").select(RECIPE_SELECT).eq("box_id", boxId),
          ]);
          if (cancelled) return;
          if (boxData) {
            initialBox = boxFromRow(boxData as BoxRow);
            boxInitialDone = true;
          } else {
            // Box vanished between subscribe and initial load.
            handlers.onBoxRemoved(boxId);
            return;
          }
          if (recipeRows) {
            initialRecipes.push(...(recipeRows as RecipeRow[]).map(recipeFromRow));
          }
          recipesInitialDone = true;
          tryEmitInitial();
        });

      boxSubs.set(boxId, () => {
        void this.client.removeChannel(channel);
      });
    };

    const reconcileBoxes = (boxes: string[]) => {
      const desired = new Set(boxes);
      for (const [boxId, unsub] of boxSubs) {
        if (!desired.has(boxId)) {
          unsub();
          boxSubs.delete(boxId);
        }
      }
      for (const boxId of boxes) ensureBoxSub(boxId);
    };

    // Drive box reconciliation from user_profiles changes.
    const userChannel: RealtimeChannel = this.client
      .channel(`recipes-user-${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "user_profiles", filter: `id=eq.${userId}` },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") return;
          const row = payload.new as { recipe_boxes?: string[]; last_seen_update_version?: number };
          const boxes = Array.isArray(row.recipe_boxes) ? row.recipe_boxes : [];
          handlers.onUser({
            id: userId,
            boxes,
            lastSeenUpdateVersion: row.last_seen_update_version ?? 0,
          });
          reconcileBoxes(boxes);
        },
      )
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED" || cancelled) return;
        const user = await this.getUser(userId);
        if (cancelled) return;
        const u = user ?? { id: userId, boxes: [], lastSeenUpdateVersion: 0 };
        handlers.onUser(u);
        reconcileBoxes(u.boxes);
      });

    return () => {
      cancelled = true;
      void this.client.removeChannel(userChannel);
      for (const unsub of boxSubs.values()) unsub();
      boxSubs.clear();
    };
  }

  // ---- helpers ----------------------------------------------------------

  private async addBoxToUserList(userId: string, boxId: string): Promise<void> {
    const { data } = await this.client
      .from("user_profiles")
      .select("recipe_boxes")
      .eq("id", userId)
      .maybeSingle();
    const current = Array.isArray(data?.recipe_boxes) ? (data!.recipe_boxes as string[]) : [];
    if (current.includes(boxId)) return;
    const { error } = await this.client
      .from("user_profiles")
      .upsert({ id: userId, recipe_boxes: [...current, boxId] }, { onConflict: "id" });
    if (error) throw error;
  }

  private async removeBoxFromUserList(userId: string, boxId: string): Promise<void> {
    const { data } = await this.client
      .from("user_profiles")
      .select("recipe_boxes")
      .eq("id", userId)
      .maybeSingle();
    const current = Array.isArray(data?.recipe_boxes) ? (data!.recipe_boxes as string[]) : [];
    if (!current.includes(boxId)) return;
    const { error } = await this.client
      .from("user_profiles")
      .upsert(
        { id: userId, recipe_boxes: current.filter((b) => b !== boxId) },
        { onConflict: "id" },
      );
    if (error) throw error;
  }
}
