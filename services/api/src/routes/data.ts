/**
 * Read/write endpoints for MCP/curl access to app data.
 * The frontend doesn't use these — it talks to PocketBase directly.
 *
 * Authorization helpers live in `../lib/authz` (see docs/auth-policy.md
 * §5.1). They are re-exported below for backward-compat with anything
 * that may have been importing them from this module.
 */
import { Hono } from "hono";
import { handler } from "../lib/handler";
import type { AppEnv } from "../index";
import type PocketBase from "pocketbase";
import {
  ManifestError,
  emptyManifest,
  defaultLifeManifest,
  addTrackable as addTrackableOp,
  updateTrackable as updateTrackableOp,
  removeTrackable as removeTrackableOp,
  reorderTrackables as reorderTrackablesOp,
  setPins as setPinsOp,
  addGoal as addGoalOp,
  updateGoal as updateGoalOp,
  removeGoal as removeGoalOp,
  reorderGoals as reorderGoalsOp,
  manifestGoals,
  addView as addViewOp,
  updateView as updateViewOp,
  removeView as removeViewOp,
  reorderViews as reorderViewsOp,
  manifestViews,
  addNotification as addNotificationOp,
  updateNotification as updateNotificationOp,
  removeNotification as removeNotificationOp,
  reorderNotifications as reorderNotificationsOp,
  manifestNotifications,
  evaluateGoal,
  type LifeManifest,
  type LifeEvent,
} from "@homelab/backend";
import {
  userOwnsTravelLog,
  userOwnsRecipeBox,
  userCanWriteRecipe,
  userOwnsTaskList,
  userOwnsLifeLog,
  userOwnsShoppingList,
  userCanReadRecipe,
  requireRole,
  stripParentPointers,
} from "../lib/authz";
import { canonicalSlotTime } from "../lib/slot-time";
import { safeTz } from "../lib/notifications/tz";

export const dataRoutes = new Hono<AppEnv>();

/**
 * Read the "notes" text entry from a unified event row's entries[] field.
 * task_events / recipe_events / life_events all share this shape — the
 * notes field is exposed as a flat string at the API boundary for
 * ergonomic Claude / curl access, even though it's stored as one entry
 * in the array.
 */
function notesFromEntries(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (const e of entries) {
    if (
      e && typeof e === "object" &&
      (e as Record<string, unknown>).name === "notes" &&
      (e as Record<string, unknown>).type === "text" &&
      typeof (e as Record<string, unknown>).value === "string"
    ) {
      return (e as Record<string, unknown>).value as string;
    }
  }
  return undefined;
}

/**
 * Normalize a `recipe_snapshot` JSON value for the API boundary.
 *
 * PB returns missing JSON columns as `{}` (the default zero value), which
 * the frontend would otherwise have to distinguish from "empty recipe" by
 * its own heuristics. Surface `null` instead so the diff UI can render the
 * disabled-with-tooltip state cleanly. Anything non-object also drops to
 * null defensively.
 */
function normalizeSnapshot(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Object.keys(raw as Record<string, unknown>).length === 0) return null;
  return raw as Record<string, unknown>;
}

/**
 * Build the entries[] patch for a notes-only edit: drop any existing
 * "notes" text entry from the row, append a new one if the caller passed
 * a non-empty value. Preserves any other entries the row may carry.
 */
function patchNotesEntries(existing: unknown, nextNotes: string | undefined): unknown[] {
  const list = Array.isArray(existing) ? existing : [];
  const filtered = list.filter(
    (e) =>
      !(e && typeof e === "object" &&
        (e as Record<string, unknown>).name === "notes" &&
        (e as Record<string, unknown>).type === "text"),
  );
  const trimmed = (nextNotes ?? "").trim();
  if (!trimmed) return filtered;
  return [...filtered, { name: "notes", type: "text", value: trimmed }];
}

/**
 * Read the 1–5 "rating" number entry from a unified event row's entries[].
 * Stored as `{name:"rating", type:"number", value, unit:"stars"}`; surfaced
 * as a flat integer at the API boundary, like notes. Out-of-range or
 * malformed values read as undefined.
 */
function ratingFromEntries(entries: unknown): number | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (const e of entries) {
    if (
      e && typeof e === "object" &&
      (e as Record<string, unknown>).name === "rating" &&
      (e as Record<string, unknown>).type === "number" &&
      isValidRating((e as Record<string, unknown>).value)
    ) {
      return (e as Record<string, unknown>).value as number;
    }
  }
  return undefined;
}

function isValidRating(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;
}

/**
 * Build the entries[] patch for a rating edit: drop any existing "rating"
 * number entry, append a new one unless `nextRating` is null (clear).
 * Caller validates the value; preserves any other entries.
 */
function patchRatingEntries(existing: unknown[], nextRating: number | null): unknown[] {
  const filtered = existing.filter(
    (e) =>
      !(e && typeof e === "object" &&
        (e as Record<string, unknown>).name === "rating" &&
        (e as Record<string, unknown>).type === "number"),
  );
  if (nextRating === null) return filtered;
  return [...filtered, { name: "rating", type: "number", value: nextRating, unit: "stars" }];
}

/** travel_notes subject scopes — kept in sync with the migration's enum. */
const NOTE_SUBJECT_TYPES = ["activity", "day", "trip"] as const;

/**
 * Validate a travel-notes `entries[]` payload against the `LifeEntry` shape
 * (the same union recipe_events / life_events / task_events use):
 *   { name, type:"text", value:string }
 *   { name, type:"number", value:number, unit:string, scale?:number }
 *   { name, type:"bool", value:boolean }
 * Returns true only if every element is a well-formed entry. An empty array
 * is allowed (a note with no entries is a no-op the caller can clean up).
 */
function validNoteEntries(entries: unknown): entries is Array<Record<string, unknown>> {
  if (!Array.isArray(entries)) return false;
  for (const e of entries) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return false;
    const r = e as Record<string, unknown>;
    if (typeof r.name !== "string" || r.name.length === 0) return false;
    if (r.type === "text") {
      if (typeof r.value !== "string") return false;
    } else if (r.type === "number") {
      if (typeof r.value !== "number" || typeof r.unit !== "string") return false;
      if (r.scale !== undefined && typeof r.scale !== "number") return false;
    } else if (r.type === "bool") {
      if (typeof r.value !== "boolean") return false;
    } else {
      return false;
    }
  }
  return true;
}

// Re-export the authz helpers for backward compatibility. New code should
// import directly from `../lib/authz` instead.
export {
  userOwnsTravelLog,
  userOwnsRecipeBox,
  userCanWriteRecipe,
  userOwnsTaskList,
  userOwnsLifeLog,
  userOwnsShoppingList,
  userCanReadRecipe,
  requireRole,
  stripParentPointers,
};

// List recipe boxes for the authenticated user
dataRoutes.get("/boxes", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const boxes = await pb.collection("recipe_boxes").getFullList({
    filter: pb.filter("owners.id ?= {:userId}", { userId }),
  });
  return c.json(boxes.map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    visibility: b.visibility,
    owners: b.owners,
  })));
}));

// List recipes in a box
dataRoutes.get("/recipes", handler(async (c) => {
  const pb = c.get("pb");
  const boxId = c.req.query("boxId");
  if (!boxId) return c.json({ error: "boxId query param required" }, 400);

  const recipes = await pb.collection("recipes").getFullList({ filter: pb.filter("box = {:boxId}", { boxId }) });
  return c.json(recipes.map((r) => ({
    id: r.id,
    box: r.box,
    name: (r.data as Record<string, unknown>)?.name,
    description: (r.data as Record<string, unknown>)?.description,
    visibility: r.visibility,
    enrichment_status: r.enrichment_status,
  })));
}));

// Get a single recipe with full data. Admin-PB bypasses PB rules, so
// without this check the route would happily return any private recipe
// to any token holder. Mirror PB's tightened (0024) visRule here.
dataRoutes.get("/recipes/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanReadRecipe(pb, id, userId);
  if (check.status !== "ok") return c.json({ error: "not found" }, 404);
  const r = check.recipe;
  return c.json({
    id: r.id,
    box: r.box,
    data: r.data,
    visibility: r.visibility,
    enrichment_status: r.enrichment_status,
    pending_changes: r.pending_changes,
    step_ingredients: r.step_ingredients,
  });
}));

// List shopping lists for the authenticated user
dataRoutes.get("/shopping/lists", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const user = await pb.collection("users").getOne(userId);
  const slugs = (user.shopping_slugs || {}) as Record<string, string>;
  const lists = await Promise.all(
    Object.entries(slugs).map(async ([slug, listId]) => {
      try {
        const list = await pb.collection("shopping_lists").getOne(listId);
        return { id: listId, slug, name: list.name };
      } catch {
        return { id: listId, slug, name: "(not found)" };
      }
    })
  );
  return c.json(lists);
}));

// List items in a shopping list. Admin-PB bypasses PB's list/view rules,
// so without this check any token holder could enumerate any list's items
// by ID. Mirror shopping_lists.viewRule (the parent gate) — items are only
// surfaced to a caller who owns the list.
dataRoutes.get("/shopping/items", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const listId = c.req.query("list");
  if (!listId) return c.json({ error: "list query param required" }, 400);
  if (!(await userOwnsShoppingList(pb, listId, userId))) {
    return c.json({ error: "not found" }, 404);
  }

  const items = await pb.collection("shopping_items").getFullList({ filter: pb.filter("list = {:listId}", { listId }) });
  return c.json(items.map((i) => ({
    id: i.id,
    ingredient: i.ingredient,
    note: i.note,
    category_id: i.category_id,
    checked: i.checked,
  })));
}));

// Add an item to a shopping list. Without the ownership check the route
// would happily plant an item under any list — see audit notes / commit
// message for the smoking gun.
dataRoutes.post("/shopping/items", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const { list, ingredient, note, category_id } = await c.req.json<{
    list: string;
    ingredient: string;
    note?: string;
    category_id?: string;
  }>();

  if (!list || !ingredient) {
    return c.json({ error: "list and ingredient required" }, 400);
  }
  if (!(await userOwnsShoppingList(pb, list, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const record = await pb.collection("shopping_items").create({
    list,
    ingredient,
    note: note || "",
    category_id: category_id || "uncategorized",
    checked: false,
    added_by: userId,
  });
  return c.json({ id: record.id, ingredient: record.ingredient }, 201);
}));

// Delete a shopping item. Fetch the item first so we know which list to
// authorize against; admin-PB skips PB's child-rule ownership check.
dataRoutes.delete("/shopping/items/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const item = await pb.collection("shopping_items").getOne(id).catch(() => null);
  if (!item) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsShoppingList(pb, item.list as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  await pb.collection("shopping_items").delete(id);
  return c.json({ success: true });
}));

// Update a shopping item — checked toggle, note, or category. Note: `list`
// is intentionally NOT in the typed body. Even if a caller passes it the
// destructure silently drops it, which blocks the reparent-attack vector
// (move a victim's item into the attacker's own list).
dataRoutes.patch("/shopping/items/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const item = await pb.collection("shopping_items").getOne(id).catch(() => null);
  if (!item) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsShoppingList(pb, item.list as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const body = await c.req.json<{
    checked?: boolean;
    note?: string;
    category_id?: string;
    ingredient?: string;
  }>();
  const updates: Record<string, unknown> = {};
  if (body.checked !== undefined) updates.checked = body.checked;
  if (body.note !== undefined) updates.note = body.note;
  if (body.category_id !== undefined) updates.category_id = body.category_id;
  if (body.ingredient !== undefined) updates.ingredient = body.ingredient;
  if (Object.keys(updates).length === 0) return c.json({ error: "no fields provided" }, 400);

  const record = await pb.collection("shopping_items").update(id, updates);
  return c.json({
    id: record.id,
    ingredient: record.ingredient,
    note: record.note,
    category_id: record.category_id,
    checked: record.checked,
  });
}));

// Create a shopping list. Stores its slug in the user's shopping_slugs map
// so it shows up in their list inventory.
dataRoutes.post("/shopping/lists", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const { name, slug } = await c.req.json<{ name: string; slug?: string }>();
  if (!name) return c.json({ error: "name required" }, 400);
  const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "list";

  const record = await pb.collection("shopping_lists").create({
    name,
    owners: [userId],
  });

  const user = await pb.collection("users").getOne(userId);
  const slugs = { ...((user.shopping_slugs || {}) as Record<string, string>), [finalSlug]: record.id };
  await pb.collection("users").update(userId, { shopping_slugs: slugs });

  return c.json({ id: record.id, name: record.name, slug: finalSlug }, 201);
}));

// Update a shopping list — rename or change its slug in the user's map.
// Mirrors shopping_lists.updateRule which admin-PB ignores.
dataRoutes.patch("/shopping/lists/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  if (!(await userOwnsShoppingList(pb, id, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const body = await c.req.json<{ name?: string; slug?: string }>();

  if (body.name !== undefined) {
    await pb.collection("shopping_lists").update(id, { name: body.name });
  }

  if (body.slug !== undefined) {
    const user = await pb.collection("users").getOne(userId);
    const slugs = { ...((user.shopping_slugs || {}) as Record<string, string>) };
    for (const [s, listId] of Object.entries(slugs)) {
      if (listId === id) delete slugs[s];
    }
    slugs[body.slug] = id;
    await pb.collection("users").update(userId, { shopping_slugs: slugs });
  }

  const record = await pb.collection("shopping_lists").getOne(id);
  return c.json({ id: record.id, name: record.name });
}));

// Delete a shopping list (and remove from user's slug map). Mirrors
// shopping_lists.deleteRule which admin-PB ignores. Pre-fix this cascaded
// into items/history/trips on the victim's list — the most destructive
// path on the shopping surface.
dataRoutes.delete("/shopping/lists/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  if (!(await userOwnsShoppingList(pb, id, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  await pb.collection("shopping_lists").delete(id);
  try {
    const user = await pb.collection("users").getOne(userId);
    const slugs = { ...((user.shopping_slugs || {}) as Record<string, string>) };
    let changed = false;
    for (const [s, listId] of Object.entries(slugs)) {
      if (listId === id) { delete slugs[s]; changed = true; }
    }
    if (changed) await pb.collection("users").update(userId, { shopping_slugs: slugs });
  } catch {}
  return c.json({ success: true });
}));

// Clear all checked items from a shopping list. Bulk-delete on someone
// else's list would silently nuke their data on admin-PB; gate on list
// ownership.
dataRoutes.post("/shopping/clear-checked", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const { list } = await c.req.json<{ list: string }>();
  if (!list) return c.json({ error: "list required" }, 400);
  if (!(await userOwnsShoppingList(pb, list, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const items = await pb.collection("shopping_items").getFullList({
    filter: pb.filter("list = {:list} && checked = true", { list }),
  });
  await Promise.all(items.map((i) => pb.collection("shopping_items").delete(i.id)));
  return c.json({ deleted: items.length });
}));

// ---- Recipe write ----

// Create a recipe box
dataRoutes.post("/boxes", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const { name, description } = await c.req.json<{ name: string; description?: string }>();
  if (!name) return c.json({ error: "name required" }, 400);

  const record = await pb.collection("recipe_boxes").create({
    name,
    description: description || "",
    visibility: "private",
    owners: [userId],
  });
  return c.json({ id: record.id, name: record.name }, 201);
}));

// Create a recipe in a box
dataRoutes.post("/recipes", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const { boxId, data } = await c.req.json<{ boxId: string; data: Record<string, unknown> }>();
  if (!boxId || !data) return c.json({ error: "boxId and data required" }, 400);
  if (!(await userOwnsRecipeBox(pb, boxId, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const record = await pb.collection("recipes").create({
    box: boxId,
    data,
    owners: [userId],
    visibility: "private",
    enrichment_status: "needed",
  });
  return c.json({ id: record.id, name: (record.data as Record<string, unknown>)?.name }, 201);
}));

// Update a recipe box (name, description, visibility)
dataRoutes.patch("/boxes/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  if (!(await userOwnsRecipeBox(pb, id, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const body = await c.req.json<{
    name?: string;
    description?: string;
    visibility?: "private" | "public" | "unlisted";
  }>();
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.visibility !== undefined) updates.visibility = body.visibility;
  if (Object.keys(updates).length === 0) return c.json({ error: "no fields provided" }, 400);

  const record = await pb.collection("recipe_boxes").update(id, updates);
  return c.json({ id: record.id, name: record.name, visibility: record.visibility });
}));

// Delete a recipe box (cascades to recipes + events)
dataRoutes.delete("/boxes/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  if (!(await userOwnsRecipeBox(pb, id, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  await pb.collection("recipe_boxes").delete(id);
  try {
    const user = await pb.collection("users").getOne(userId);
    const boxes = (user.recipe_boxes || []) as string[];
    if (boxes.includes(id)) {
      await pb.collection("users").update(userId, { recipe_boxes: boxes.filter((b) => b !== id) });
    }
  } catch {}
  return c.json({ success: true });
}));

// Subscribe authenticated user to a box. Requires the caller be able to
// SEE the box per PB's box viewRule (boxVisRule from 0001):
//   visibility=public OR caller in owners OR (authed AND visibility!=private)
// Otherwise an attacker could subscribe to (and pollute the subscribers
// list of) a victim's private box via admin-PB.
dataRoutes.post("/boxes/:id/subscribe", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const box = await pb.collection("recipe_boxes").getOne(id).catch(() => null);
  if (!box) return c.json({ error: "not found" }, 404);
  const owners = (box.owners as string[] | undefined) ?? [];
  const visibility = box.visibility as string | undefined;
  const canSeeBox =
    visibility === "public" ||
    owners.includes(userId) ||
    (visibility !== "private");
  if (!canSeeBox) return c.json({ error: "not found" }, 404);
  const user = await pb.collection("users").getOne(userId);
  const boxes = (user.recipe_boxes || []) as string[];
  await Promise.all([
    boxes.includes(id)
      ? Promise.resolve()
      : pb.collection("users").update(userId, { recipe_boxes: [...boxes, id] }),
    pb.collection("recipe_boxes").update(id, { "subscribers+": userId }),
  ]);
  return c.json({ success: true });
}));

// Unsubscribe authenticated user from a box
dataRoutes.post("/boxes/:id/unsubscribe", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const user = await pb.collection("users").getOne(userId);
  const boxes = (user.recipe_boxes || []) as string[];
  await Promise.all([
    pb.collection("users").update(userId, { recipe_boxes: boxes.filter((b) => b !== id) }),
    pb.collection("recipe_boxes").update(id, { "subscribers-": userId }),
  ]);
  return c.json({ success: true });
}));

// Update a recipe (data and/or visibility). Note: `box` is NOT in the
// typed body — even pre-fix, PB schema enforces visibility/data shape, but
// the route should never accept a reparenting `box` field from the body
// (it would let an attacker move a victim's recipe into their own box).
// We don't read `body.box` explicitly, but the type-narrowed destructure
// already drops it.
dataRoutes.patch("/recipes/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanWriteRecipe(pb, id, userId);
  if (check === "notfound") return c.json({ error: "not found" }, 404);
  if (check === "denied") return c.json({ error: "access denied" }, 403);
  const body = await c.req.json<{
    data?: Record<string, unknown>;
    visibility?: "private" | "public" | "unlisted";
  }>();
  const updates: Record<string, unknown> = {};
  if (body.data !== undefined) {
    updates.data = body.data;
    updates.last_updated_by = userId;
    updates.enrichment_status = "needed";
    updates.pending_changes = null;
  }
  if (body.visibility !== undefined) updates.visibility = body.visibility;
  if (Object.keys(updates).length === 0) return c.json({ error: "no fields provided" }, 400);

  const record = await pb.collection("recipes").update(id, updates);
  return c.json({
    id: record.id,
    name: (record.data as Record<string, unknown>)?.name,
    visibility: record.visibility,
  });
}));

// ── Surgical recipe.data ops ────────────────────────────────────
// All ops below read the recipe, mutate the named locality of `data`,
// and write back. Each mutation invalidates `enrichment_status` and
// clears `pending_changes` to mirror the whole-replace PATCH.

interface RecipeStep {
  "@type"?: string;
  text: string;
  ingredients?: string[];
}

async function mutateRecipeData<T>(
  pb: PB,
  userId: string,
  id: string,
  fn: (data: Record<string, unknown>) => T | { error: string },
): Promise<{ result: T; data: Record<string, unknown> } | { error: string; status: number }> {
  const record = await pb.collection("recipes").getOne(id);
  const data: Record<string, unknown> = { ...((record.data as Record<string, unknown>) || {}) };
  // Shallow-clone the array fields callers might mutate, so we don't mutate
  // the cached record arrays in place.
  if (Array.isArray(data.recipeIngredient)) data.recipeIngredient = [...(data.recipeIngredient as string[])];
  if (Array.isArray(data.recipeInstructions)) {
    data.recipeInstructions = (data.recipeInstructions as RecipeStep[]).map((s) => ({ ...s }));
  }
  const result = fn(data);
  if (result && typeof result === "object" && "error" in result) {
    return { error: (result as { error: string }).error, status: 400 };
  }
  await pb.collection("recipes").update(id, {
    data,
    last_updated_by: userId,
    enrichment_status: "needed",
    pending_changes: null,
  });
  return { result: result as T, data };
}

function recipeArrayResponse(
  field: "recipeIngredient" | "recipeInstructions",
  data: Record<string, unknown>,
) {
  return {
    field,
    count: Array.isArray(data[field]) ? (data[field] as unknown[]).length : 0,
    items: data[field] ?? [],
  };
}

// Merge top-level recipe.data fields (name, description, recipeYield, etc).
// Use null to clear a field. For ingredient/step arrays, prefer the
// dedicated surgical ops below — passing them here whole-replaces.
dataRoutes.patch("/recipes/:id/data", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanWriteRecipe(pb, id, userId);
  if (check === "notfound") return c.json({ error: "not found" }, 404);
  if (check === "denied") return c.json({ error: "access denied" }, 403);
  const body = await c.req.json<{ fields: Record<string, unknown> }>();
  if (!body.fields || typeof body.fields !== "object") {
    return c.json({ error: "fields object required" }, 400);
  }

  const out = await mutateRecipeData(pb, userId, id, (data) => {
    for (const [k, v] of Object.entries(body.fields)) {
      if (v === null) delete data[k];
      else data[k] = v;
    }
    return { fields_changed: Object.keys(body.fields) };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ id, ...out.result, name: out.data.name });
}));

// Add an ingredient (default: append to end).
dataRoutes.post("/recipes/:id/ingredients", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanWriteRecipe(pb, id, userId);
  if (check === "notfound") return c.json({ error: "not found" }, 404);
  if (check === "denied") return c.json({ error: "access denied" }, 403);
  const body = await c.req.json<{ ingredient: string; position?: number }>();
  if (!body.ingredient || typeof body.ingredient !== "string") {
    return c.json({ error: "ingredient string required" }, 400);
  }

  const out = await mutateRecipeData(pb, userId, id, (data) => {
    const list = (data.recipeIngredient as string[] | undefined) ?? [];
    const pos = body.position ?? list.length;
    const clamped = Math.max(0, Math.min(list.length, pos));
    list.splice(clamped, 0, body.ingredient);
    data.recipeIngredient = list;
    return { position: clamped };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ id, ...out.result, ...recipeArrayResponse("recipeIngredient", out.data) });
}));

// Update a single ingredient by index.
dataRoutes.patch("/recipes/:id/ingredients/:index", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanWriteRecipe(pb, id, userId);
  if (check === "notfound") return c.json({ error: "not found" }, 404);
  if (check === "denied") return c.json({ error: "access denied" }, 403);
  const idx = parseInt(c.req.param("index")!, 10);
  const { ingredient } = await c.req.json<{ ingredient: string }>();
  if (!ingredient || typeof ingredient !== "string") {
    return c.json({ error: "ingredient string required" }, 400);
  }

  const out = await mutateRecipeData(pb, userId, id, (data) => {
    const list = (data.recipeIngredient as string[] | undefined) ?? [];
    if (idx < 0 || idx >= list.length) return { error: `index ${idx} out of range (have ${list.length})` };
    list[idx] = ingredient;
    data.recipeIngredient = list;
    return { index: idx };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ id, ...out.result, ...recipeArrayResponse("recipeIngredient", out.data) });
}));

// Remove an ingredient by index.
dataRoutes.delete("/recipes/:id/ingredients/:index", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanWriteRecipe(pb, id, userId);
  if (check === "notfound") return c.json({ error: "not found" }, 404);
  if (check === "denied") return c.json({ error: "access denied" }, 403);
  const idx = parseInt(c.req.param("index")!, 10);

  const out = await mutateRecipeData(pb, userId, id, (data) => {
    const list = (data.recipeIngredient as string[] | undefined) ?? [];
    if (idx < 0 || idx >= list.length) return { error: `index ${idx} out of range` };
    const removed = list.splice(idx, 1)[0];
    data.recipeIngredient = list;
    return { removed, index: idx };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ id, ...out.result, ...recipeArrayResponse("recipeIngredient", out.data) });
}));

// Reorder ingredients. `order` is a permutation: new[i] = old[order[i]].
dataRoutes.post("/recipes/:id/ingredients/reorder", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanWriteRecipe(pb, id, userId);
  if (check === "notfound") return c.json({ error: "not found" }, 404);
  if (check === "denied") return c.json({ error: "access denied" }, 403);
  const { order } = await c.req.json<{ order: number[] }>();
  if (!Array.isArray(order)) return c.json({ error: "order must be an array of integers" }, 400);

  const out = await mutateRecipeData(pb, userId, id, (data) => {
    const list = (data.recipeIngredient as string[] | undefined) ?? [];
    const err = validatePermutation(order, list.length);
    if (err) return { error: err };
    data.recipeIngredient = order.map((i) => list[i]);
    return {};
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ id, ...recipeArrayResponse("recipeIngredient", out.data) });
}));

// ── Steps ──────────────────────────────────────────────────────

// Add a recipe step (default: append).
dataRoutes.post("/recipes/:id/steps", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanWriteRecipe(pb, id, userId);
  if (check === "notfound") return c.json({ error: "not found" }, 404);
  if (check === "denied") return c.json({ error: "access denied" }, 403);
  const body = await c.req.json<{ text: string; ingredients?: string[]; position?: number }>();
  if (!body.text || typeof body.text !== "string") {
    return c.json({ error: "text required" }, 400);
  }

  const step: RecipeStep = { "@type": "HowToStep", text: body.text };
  if (body.ingredients && body.ingredients.length > 0) step.ingredients = body.ingredients;

  const out = await mutateRecipeData(pb, userId, id, (data) => {
    const list = (data.recipeInstructions as RecipeStep[] | undefined) ?? [];
    const pos = body.position ?? list.length;
    const clamped = Math.max(0, Math.min(list.length, pos));
    list.splice(clamped, 0, step);
    data.recipeInstructions = list;
    return { position: clamped };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ id, ...out.result, ...recipeArrayResponse("recipeInstructions", out.data) });
}));

// Update a step. `text` and `ingredients` are independently patchable.
// Pass ingredients=null to drop the field.
dataRoutes.patch("/recipes/:id/steps/:index", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanWriteRecipe(pb, id, userId);
  if (check === "notfound") return c.json({ error: "not found" }, 404);
  if (check === "denied") return c.json({ error: "access denied" }, 403);
  const idx = parseInt(c.req.param("index")!, 10);
  const body = await c.req.json<{ text?: string; ingredients?: string[] | null }>();

  const out = await mutateRecipeData(pb, userId, id, (data) => {
    const list = (data.recipeInstructions as RecipeStep[] | undefined) ?? [];
    if (idx < 0 || idx >= list.length) return { error: `index ${idx} out of range` };
    const step = list[idx];
    if (body.text !== undefined) step.text = body.text;
    if (body.ingredients === null) delete step.ingredients;
    else if (body.ingredients !== undefined) step.ingredients = body.ingredients;
    data.recipeInstructions = list;
    return { index: idx };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ id, ...out.result, ...recipeArrayResponse("recipeInstructions", out.data) });
}));

// Remove a step by index.
dataRoutes.delete("/recipes/:id/steps/:index", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanWriteRecipe(pb, id, userId);
  if (check === "notfound") return c.json({ error: "not found" }, 404);
  if (check === "denied") return c.json({ error: "access denied" }, 403);
  const idx = parseInt(c.req.param("index")!, 10);

  const out = await mutateRecipeData(pb, userId, id, (data) => {
    const list = (data.recipeInstructions as RecipeStep[] | undefined) ?? [];
    if (idx < 0 || idx >= list.length) return { error: `index ${idx} out of range` };
    const removed = list.splice(idx, 1)[0];
    data.recipeInstructions = list;
    return { removed, index: idx };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ id, ...out.result, ...recipeArrayResponse("recipeInstructions", out.data) });
}));

// Reorder steps; same permutation contract as ingredients.
dataRoutes.post("/recipes/:id/steps/reorder", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanWriteRecipe(pb, id, userId);
  if (check === "notfound") return c.json({ error: "not found" }, 404);
  if (check === "denied") return c.json({ error: "access denied" }, 403);
  const { order } = await c.req.json<{ order: number[] }>();
  if (!Array.isArray(order)) return c.json({ error: "order must be an array of integers" }, 400);

  const out = await mutateRecipeData(pb, userId, id, (data) => {
    const list = (data.recipeInstructions as RecipeStep[] | undefined) ?? [];
    const err = validatePermutation(order, list.length);
    if (err) return { error: err };
    data.recipeInstructions = order.map((i) => list[i]);
    return {};
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ id, ...recipeArrayResponse("recipeInstructions", out.data) });
}));

function validatePermutation(order: number[], n: number): string | null {
  if (order.length !== n) return `order length ${order.length} doesn't match item count ${n}`;
  const seen = new Set<number>();
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= n) return `order contains invalid index ${i}`;
    if (seen.has(i)) return `order has duplicate index ${i}`;
    seen.add(i);
  }
  return null;
}

// Delete a recipe
dataRoutes.delete("/recipes/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanWriteRecipe(pb, id, userId);
  if (check === "notfound") return c.json({ error: "not found" }, 404);
  if (check === "denied") return c.json({ error: "access denied" }, 403);
  await pb.collection("recipes").delete(id);
  return c.json({ success: true });
}));

// List cooking log events for a recipe. Read-gated through the same recipe
// read check as GET /recipes/:id — if you can't see the recipe, you can't
// see when it was cooked.
//
// Returns `recipe_snapshot` (the recipe.data captured at cook time) inline so
// the frontend can render its "what changed since I cooked it" diff without a
// per-entry roundtrip. Rows that predate the feature have no snapshot — they
// surface as `recipe_snapshot: null`.
dataRoutes.get("/recipes/:id/cooking-log", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const check = await userCanReadRecipe(pb, id, userId);
  if (check.status !== "ok") return c.json({ error: "not found" }, 404);
  const recipe = check.recipe;
  const events = await pb.collection("recipe_events").getFullList({
    filter: pb.filter("box = {:boxId} && subject_id = {:recipeId}", { boxId: recipe.box as string, recipeId: id }),
    sort: "-timestamp",
  });
  return c.json(events.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    notes: notesFromEntries(e.entries),
    rating: ratingFromEntries(e.entries),
    recipe_snapshot: normalizeSnapshot(e.recipe_snapshot),
    created_by: e.created_by,
    created: e.created,
  })));
}));

// Add a cooking log entry for a recipe. Cooking-log events belong to the
// recipe's box (recipe_events.box → recipe_boxes), so authorization must
// flow through `box.owners`. Recipe-level owners aren't enough — PB's own
// `recipe_events` updateRule (childRules-based) requires box ownership.
//
// Snapshots `recipe.data` at write time onto `recipe_snapshot` so the
// "what changed?" UI can later diff against the live recipe. Unconditional
// — no opt-in. Snapshot is intentionally NOT touched by PATCH (the
// snapshot represents the cook session, not the row's edit history).
dataRoutes.post("/recipes/:id/cooking-log", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const recipe = await pb.collection("recipes").getOne(id).catch(() => null);
  if (!recipe) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsRecipeBox(pb, recipe.box as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const body = await c.req.json<{ notes?: string; rating?: unknown; timestamp?: string }>().catch(
    () => ({} as { notes?: string; rating?: unknown; timestamp?: string }),
  );
  // PATCH accepts `rating: null` as "clear the rating"; on create there is
  // nothing to clear, so null degrades to "no rating" instead of a 400 —
  // callers can use one payload shape for both verbs.
  const rating = body.rating === null ? undefined : body.rating;
  if (rating !== undefined && !isValidRating(rating)) {
    return c.json({ error: "rating must be an integer between 1 and 5" }, 400);
  }
  const snapshot = normalizeSnapshot(recipe.data);
  const entries = patchNotesEntries([], body.notes);
  const record = await pb.collection("recipe_events").create({
    box: recipe.box,
    subject_id: id,
    timestamp: body.timestamp ?? new Date().toISOString(),
    created_by: userId,
    entries: rating === undefined ? entries : patchRatingEntries(entries, rating),
    recipe_snapshot: snapshot ?? null,
  });
  return c.json({ id: record.id, timestamp: record.timestamp }, 201);
}));

// Update notes, rating, and/or timestamp on a cooking log entry. Empty-string
// notes clears the notes; null rating clears the rating. Timestamp lets
// callers fix a wrong-day cook entry without delete + re-add. Authorization
// flows through the event's parent box.
dataRoutes.patch("/cooking-log/:eventId", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const eventId = c.req.param("eventId")!;
  const record = await pb.collection("recipe_events").getOne(eventId).catch(() => null);
  if (!record) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsRecipeBox(pb, record.box as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const body = await c.req.json<{ notes?: string; rating?: unknown; timestamp?: string }>();
  if (body.rating !== undefined && body.rating !== null && !isValidRating(body.rating)) {
    return c.json({ error: "rating must be an integer between 1 and 5, or null to clear" }, 400);
  }
  const update: Record<string, unknown> = {};
  let entries = Array.isArray(record.entries) ? (record.entries as unknown[]) : [];
  if (body.notes !== undefined) {
    entries = patchNotesEntries(entries, body.notes);
    update.entries = entries;
  }
  if (body.rating !== undefined) {
    entries = patchRatingEntries(entries, body.rating as number | null);
    update.entries = entries;
  }
  if (body.timestamp !== undefined) update.timestamp = body.timestamp;
  if (Object.keys(update).length === 0) return c.json({ error: "no fields provided" }, 400);
  const updated = await pb.collection("recipe_events").update(eventId, update);
  return c.json({
    id: updated.id,
    timestamp: updated.timestamp,
    notes: notesFromEntries(updated.entries),
    rating: ratingFromEntries(updated.entries),
  });
}));

// Delete a cooking log entry. Same box-ownership gate as PATCH.
dataRoutes.delete("/cooking-log/:eventId", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const eventId = c.req.param("eventId")!;
  const record = await pb.collection("recipe_events").getOne(eventId).catch(() => null);
  if (!record) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsRecipeBox(pb, record.box as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  await pb.collection("recipe_events").delete(eventId);
  return c.json({ success: true });
}));

// ---- Travel ----

// List travel logs for the authenticated user
dataRoutes.get("/travel/logs", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const user = await pb.collection("users").getOne(userId);
  const slugs = (user.travel_slugs || {}) as Record<string, string>;
  const logs = await Promise.all(
    Object.entries(slugs).map(async ([slug, logId]) => {
      try {
        const log = await pb.collection("travel_logs").getOne(logId);
        return { id: logId, slug, name: log.name };
      } catch {
        return { id: logId, slug, name: "(not found)" };
      }
    })
  );
  return c.json(logs);
}));

// List trips in a travel log
dataRoutes.get("/travel/trips", handler(async (c) => {
  const pb = c.get("pb");
  const logId = c.req.query("log");
  if (!logId) return c.json({ error: "log query param required" }, 400);
  const status = c.req.query("status"); // optional filter by status

  const filter = status
    ? pb.filter("log = {:logId} && status = {:status}", { logId, status })
    : pb.filter("log = {:logId}", { logId });

  const trips = await pb.collection("travel_trips").getFullList({ filter });
  return c.json(trips.map((t) => ({
    id: t.id,
    log: t.log,
    destination: t.destination,
    status: t.status,
    region: t.region,
    start_date: t.start_date,
    end_date: t.end_date,
  })));
}));

// Get a single trip with full details
dataRoutes.get("/travel/trips/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const t = await pb.collection("travel_trips").getOne(id);
  return c.json({
    id: t.id,
    log: t.log,
    destination: t.destination,
    status: t.status,
    region: t.region,
    start_date: t.start_date,
    end_date: t.end_date,
    flagged_for_review: t.flagged_for_review,
    review_comment: t.review_comment,
  });
}));

// Build write-time warnings: surface data shapes that the UI/map can't
// render so the caller knows to fix them before they cause a silent gap on
// the itinerary. Returned only on create/update — read paths don't include
// `warnings` (callers can derive them client-side from the same fields).
function activityWarnings(a: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const hasLocation = typeof a.location === "string" && a.location.length > 0;
  const hasCoords = typeof a.lat === "number" && typeof a.lng === "number";
  if (a.category !== "Flight" && hasLocation && !hasCoords) {
    warnings.push("Activity has location but no lat/lng — call geocode_activity to plot it on the map.");
  }
  if (a.category === "Flight") {
    const fi = (a.flight_info as Record<string, unknown> | null) || null;
    const fromOk = fi && typeof fi.fromLat === "number" && typeof fi.fromLng === "number";
    const toOk = fi && typeof fi.toLat === "number" && typeof fi.toLng === "number";
    if (!fromOk || !toOk) {
      warnings.push("Flight is missing one or both endpoint coords — call geocode_activity to backfill from airport codes.");
    }
  }
  return warnings;
}

// Shape every activity response identically — write-side and read-side stay
// in sync so a fetched activity round-trips losslessly.
function activityResponse(a: Record<string, unknown>) {
  return {
    id: a.id,
    log: a.log,
    name: a.name,
    category: a.category,
    location: a.location,
    place_id: a.place_id,
    lat: a.lat,
    lng: a.lng,
    description: a.description,
    cost_notes: a.cost_notes,
    duration_estimate: a.duration_estimate,
    walk_miles: a.walk_miles,
    elevation_gain_feet: a.elevation_gain_feet,
    difficulty: a.difficulty,
    confirmation_code: a.confirmation_code,
    details: a.details,
    setting: a.setting,
    rating: a.rating,
    rating_count: a.rating_count,
    photo_ref: a.photo_ref,
    flight_info: a.flight_info,
    experienced_at: a.experienced_at,
    trip_id: a.trip_id,
  };
}

// List activities in a travel log (optionally filtered by trip_id)
dataRoutes.get("/travel/activities", handler(async (c) => {
  const pb = c.get("pb");
  const logId = c.req.query("log");
  if (!logId) return c.json({ error: "log query param required" }, 400);
  const tripId = c.req.query("trip_id");

  let filter = pb.filter("log = {:logId}", { logId });
  if (tripId) filter += " && " + pb.filter("trip_id = {:tripId}", { tripId });

  const activities = await pb.collection("travel_activities").getFullList({ filter });
  return c.json(activities.map((a) => activityResponse(a)));
}));

// Get a single travel activity with full data
dataRoutes.get("/travel/activities/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const a = await pb.collection("travel_activities").getOne(id);
  return c.json(activityResponse(a));
}));

// List itineraries in a travel log (optionally filtered by trip_id)
dataRoutes.get("/travel/itineraries", handler(async (c) => {
  const pb = c.get("pb");
  const logId = c.req.query("log");
  if (!logId) return c.json({ error: "log query param required" }, 400);
  const tripId = c.req.query("trip_id");

  let filter = pb.filter("log = {:logId}", { logId });
  if (tripId) filter += " && " + pb.filter("trip_id = {:tripId}", { tripId });

  const itineraries = await pb.collection("travel_itineraries").getFullList({ filter });
  return c.json(itineraries.map((i) => ({
    id: i.id,
    log: i.log,
    trip_id: i.trip_id,
    name: i.name,
    is_active: i.is_active,
    days: i.days,
  })));
}));

// Create a travel trip
dataRoutes.post("/travel/trips", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{
    log: string;
    destination: string;
    status?: string;
    region?: string;
    start_date?: string;
    end_date?: string;
  }>();
  if (!body.log || !body.destination) return c.json({ error: "log and destination required" }, 400);
  if (!(await userOwnsTravelLog(pb, body.log, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const record = await pb.collection("travel_trips").create({
    log: body.log,
    destination: body.destination,
    status: body.status || "planning",
    region: body.region || "",
    start_date: body.start_date || "",
    end_date: body.end_date || "",
  });
  return c.json({ id: record.id, destination: record.destination }, 201);
}));

// Update a travel trip
dataRoutes.patch("/travel/trips/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const body = await c.req.json<Record<string, unknown>>();
  const existing = await pb.collection("travel_trips").getOne(id).catch(() => null);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, existing.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  // Reparenting (changing `log`) is not a legitimate operation through this
  // endpoint — strip it so an attacker can't move the trip into their own log.
  const safeBody = stripParentPointers(body, "log");
  const record = await pb.collection("travel_trips").update(id, safeBody);
  return c.json({
    id: record.id,
    destination: record.destination,
    status: record.status,
    region: record.region,
    start_date: record.start_date,
    end_date: record.end_date,
  });
}));

// Create a travel activity
dataRoutes.post("/travel/activities", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{
    log: string;
    trip_id?: string;
    name: string;
    category?: string;
    location?: string;
    description?: string;
    cost_notes?: string;
    duration_estimate?: string;
    walk_miles?: number;
    elevation_gain_feet?: number;
    difficulty?: string;
    setting?: string;
    confirmation_code?: string;
    details?: string;
    flight_info?: Record<string, unknown> | null;
    experienced_at?: string;
  }>();
  if (!body.log || !body.name) return c.json({ error: "log and name required" }, 400);
  if (!(await userOwnsTravelLog(pb, body.log, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const record = await pb.collection("travel_activities").create({
    log: body.log,
    trip_id: body.trip_id || "",
    name: body.name,
    category: body.category || "",
    location: body.location || "",
    description: body.description || "",
    cost_notes: body.cost_notes || "",
    duration_estimate: body.duration_estimate || "",
    walk_miles: body.walk_miles ?? null,
    elevation_gain_feet: body.elevation_gain_feet ?? null,
    difficulty: body.difficulty || "",
    setting: body.setting || "",
    confirmation_code: body.confirmation_code || "",
    details: body.details || "",
    flight_info: body.flight_info ?? null,
    experienced_at: body.experienced_at || "",
  });
  const warnings = activityWarnings(record);
  return c.json({ ...activityResponse(record), ...(warnings.length ? { warnings } : {}) }, 201);
}));

// Update a travel activity. Whitelisted to schema fields so callers can't
// accidentally write arbitrary keys.
dataRoutes.patch("/travel/activities/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const body = await c.req.json<Record<string, unknown>>();
  const existing = await pb.collection("travel_activities").getOne(id).catch(() => null);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, existing.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const allowed = [
    "name", "category", "location", "place_id", "lat", "lng",
    "description", "cost_notes", "duration_estimate", "walk_miles",
    "elevation_gain_feet", "difficulty", "confirmation_code",
    "details", "setting", "rating", "rating_count",
    "photo_ref", "flight_info", "experienced_at",
    "trip_id",
  ];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key];
  }
  const record = await pb.collection("travel_activities").update(id, updates);
  const warnings = activityWarnings(record);
  return c.json({ ...activityResponse(record), ...(warnings.length ? { warnings } : {}) });
}));

// Create a travel itinerary
dataRoutes.post("/travel/itineraries", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{
    log: string;
    trip_id: string;
    name: string;
    is_active?: boolean;
    days?: unknown;
  }>();
  if (!body.log || !body.trip_id || !body.name) return c.json({ error: "log, trip_id, and name required" }, 400);
  if (!(await userOwnsTravelLog(pb, body.log, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const record = await pb.collection("travel_itineraries").create({
    log: body.log,
    trip_id: body.trip_id,
    name: body.name,
    is_active: body.is_active ?? false,
    days: body.days || [],
  });
  return c.json({ id: record.id, name: record.name }, 201);
}));

// Delete a travel trip
dataRoutes.delete("/travel/trips/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const existing = await pb.collection("travel_trips").getOne(id).catch(() => null);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, existing.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  await pb.collection("travel_trips").delete(id);
  return c.json({ success: true });
}));

// Delete a travel activity
dataRoutes.delete("/travel/activities/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const existing = await pb.collection("travel_activities").getOne(id).catch(() => null);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, existing.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  await pb.collection("travel_activities").delete(id);
  return c.json({ success: true });
}));

// Delete a travel itinerary
dataRoutes.delete("/travel/itineraries/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const existing = await pb.collection("travel_itineraries").getOne(id).catch(() => null);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, existing.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  await pb.collection("travel_itineraries").delete(id);
  return c.json({ success: true });
}));

// Update a travel itinerary
dataRoutes.patch("/travel/itineraries/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const body = await c.req.json<Record<string, unknown>>();
  const existing = await pb.collection("travel_itineraries").getOne(id).catch(() => null);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, existing.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  // Same reparent-block as trips/activities.
  const safeBody = stripParentPointers(body, "log");
  const record = await pb.collection("travel_itineraries").update(id, safeBody);
  return c.json({
    id: record.id,
    name: record.name,
    is_active: record.is_active,
    trip_id: record.trip_id,
    days: record.days,
  });
}));

// Geocode a single travel activity using Google Places API
dataRoutes.post("/travel/activities/:id/geocode", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;

  // Ownership check FIRST — don't leak existence of the activity or burn
  // a config-error response on an unauthorized caller.
  const activity = await pb.collection("travel_activities").getOne(id).catch(() => null);
  if (!activity) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, activity.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return c.json({ error: "VITE_GOOGLE_MAPS_API_KEY not configured on the server" }, 500);
  }

  const body: { searchQuery?: string } = await c.req.json<{ searchQuery?: string }>().catch(() => ({}));

  async function searchPlace(q: string) {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey!,
        "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.formattedAddress",
      },
      body: JSON.stringify({ textQuery: q }),
    });
    if (!res.ok) throw new Error(`Places API ${res.status}: ${await res.text()}`);
    const data = await res.json() as {
      places?: Array<{ id: string; displayName?: { text: string }; location?: { latitude: number; longitude: number }; formattedAddress?: string }>;
    };
    return data.places?.[0] || null;
  }

  // Flight: geocode both from and to airports into flight_info
  if (activity.category === "Flight") {
    const fi = activity.flight_info || {};
    const fromCode = fi.from as string | undefined;
    const toCode = fi.to as string | undefined;
    if (!fromCode || !toCode) {
      return c.json({ error: "Flight missing from/to airport codes" }, 400);
    }
    const fromPlace = await searchPlace(`${fromCode} airport`);
    const toPlace = await searchPlace(`${toCode} airport`);
    if (!fromPlace || !toPlace) {
      return c.json({ error: `Could not find airports: from=${!!fromPlace} to=${!!toPlace}` }, 404);
    }
    const newFi = {
      ...fi,
      fromLat: fromPlace.location?.latitude,
      fromLng: fromPlace.location?.longitude,
      toLat: toPlace.location?.latitude,
      toLng: toPlace.location?.longitude,
    };
    // Also set the activity's primary lat/lng to the departure airport so
    // it appears somewhere if flight_info is stripped
    const updated = await pb.collection("travel_activities").update(id, {
      flight_info: newFi,
      lat: fromPlace.location?.latitude,
      lng: fromPlace.location?.longitude,
    });
    return c.json({
      id: updated.id,
      name: updated.name,
      flight_info: updated.flight_info,
      fromPlace: fromPlace.displayName?.text,
      toPlace: toPlace.displayName?.text,
    });
  }

  let searchQuery = body.searchQuery;
  if (!searchQuery) {
    // For Transportation activities with a trip, use trip destination + "airport"
    if (activity.category === "Transportation" && activity.trip_id) {
      try {
        const trip = await pb.collection("travel_trips").getOne(activity.trip_id as string);
        searchQuery = `${trip.destination} airport`;
      } catch {
        // Fall through to default
      }
    }
    // Default: activity name + location
    if (!searchQuery) {
      searchQuery = [activity.name, activity.location].filter(Boolean).join(", ");
    }
  }

  if (!searchQuery) {
    return c.json({ error: "Could not construct a search query — activity has no name or location" }, 400);
  }

  const place = await searchPlace(searchQuery);
  if (!place) {
    return c.json({ error: `No places found for query: "${searchQuery}"` }, 404);
  }

  const updated = await pb.collection("travel_activities").update(id, {
    place_id: place.id,
    lat: place.location?.latitude ?? 0,
    lng: place.location?.longitude ?? 0,
  });

  return c.json({
    id: updated.id,
    name: updated.name,
    place_id: updated.place_id,
    lat: updated.lat,
    lng: updated.lng,
    searchQuery,
    placeName: place.displayName?.text,
    formattedAddress: place.formattedAddress,
  });
}));

// Batch geocode travel activities
dataRoutes.post("/travel/activities/batch-geocode", handler(async (c) => {
  const pb = c.get("pb");

  const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return c.json({ error: "VITE_GOOGLE_MAPS_API_KEY not configured on the server" }, 500);
  }

  const body = await c.req.json<{ log: string; trip_id?: string }>();
  if (!body.log) return c.json({ error: "log required" }, 400);

  let filter = pb.filter("log = {:log}", { log: body.log });
  if (body.trip_id) filter += " && " + pb.filter("trip_id = {:tripId}", { tripId: body.trip_id });
  // Only activities without a place_id
  filter += ' && place_id = ""';

  const activities = await pb.collection("travel_activities").getFullList({ filter });
  let geocoded = 0;
  let skipped = 0;
  let errors = 0;
  const details: Array<{ id: string; name: string; status: string; error?: string }> = [];

  for (const activity of activities) {
    // Construct search query
    let searchQuery: string | undefined;

    if (activity.category === "Transportation" && activity.trip_id) {
      try {
        const trip = await pb.collection("travel_trips").getOne(activity.trip_id as string);
        searchQuery = `${trip.destination} airport`;
      } catch {
        // Fall through
      }
    }
    if (!searchQuery) {
      searchQuery = [activity.name, activity.location].filter(Boolean).join(", ");
    }

    if (!searchQuery) {
      skipped++;
      details.push({ id: activity.id, name: activity.name as string, status: "skipped", error: "no name or location" });
      continue;
    }

    try {
      const placesRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.formattedAddress",
        },
        body: JSON.stringify({ textQuery: searchQuery }),
      });

      if (!placesRes.ok) {
        errors++;
        const errBody = await placesRes.text();
        details.push({ id: activity.id, name: activity.name as string, status: "error", error: `Places API ${placesRes.status}: ${errBody}` });
        continue;
      }

      const placesData = await placesRes.json() as {
        places?: Array<{
          id: string;
          location?: { latitude: number; longitude: number };
        }>;
      };

      const place = placesData.places?.[0];
      if (!place) {
        skipped++;
        details.push({ id: activity.id, name: activity.name as string, status: "skipped", error: `no results for "${searchQuery}"` });
        continue;
      }

      await pb.collection("travel_activities").update(activity.id, {
        place_id: place.id,
        lat: place.location?.latitude ?? 0,
        lng: place.location?.longitude ?? 0,
      });

      geocoded++;
      details.push({ id: activity.id, name: activity.name as string, status: "geocoded" });

      // Small delay between API calls to avoid rate limiting
      if (activities.indexOf(activity) < activities.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch (err) {
      errors++;
      details.push({ id: activity.id, name: activity.name as string, status: "error", error: String(err) });
    }
  }

  return c.json({ total: activities.length, geocoded, skipped, errors, details });
}));

// Replace the days array on a travel itinerary
dataRoutes.put("/travel/itineraries/:id/days", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const { days } = await c.req.json<{ days: unknown }>();
  if (days === undefined) return c.json({ error: "days array required" }, 400);

  const existing = await pb.collection("travel_itineraries").getOne(id).catch(() => null);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, existing.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const record = await pb.collection("travel_itineraries").update(id, { days });
  return c.json({
    id: record.id,
    name: record.name,
    days: record.days,
  });
}));

// ── Targeted itinerary patch ops ────────────────────────────────
// All ops below read days, mutate the named locality, and write back.
// Concurrent callers race at the days-array level — last write wins.
// (Optimistic locking would need a `version` column on travel_itineraries.)
//
// Each op returns the affected day(s) only — clients can splice into local
// state without re-fetching the whole itinerary.

interface ItinerarySlot {
  activityId: string;
  startTime?: string;
  dayNote?: string;
}
interface ItineraryDay {
  date?: string;
  label: string;
  lodgingActivityId?: string;
  flights?: ItinerarySlot[];
  slots: ItinerarySlot[];
}

type PB = import("pocketbase").default;

async function mutateDays<T>(
  pb: PB,
  id: string,
  userId: string,
  fn: (days: ItineraryDay[]) => T | { error: string; status?: number },
): Promise<{ days: ItineraryDay[]; result: T } | { error: string; status: number }> {
  const record = await pb.collection("travel_itineraries").getOne(id).catch(() => null);
  if (!record) return { error: "not found", status: 404 };
  if (!(await userOwnsTravelLog(pb, record.log as string, userId))) {
    return { error: "access denied", status: 403 };
  }
  const days = ((record.days || []) as ItineraryDay[]).map((d) => ({ ...d, slots: [...(d.slots || [])] }));
  const result = fn(days);
  if (result && typeof result === "object" && "error" in result) {
    return { error: (result as { error: string }).error, status: (result as { status?: number }).status ?? 400 };
  }
  await pb.collection("travel_itineraries").update(id, { days });
  return { days, result: result as T };
}

function parseIdx(s: string | undefined, label: string): number | { error: string } {
  if (s === undefined) return { error: `${label} required` };
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative integer` };
  return n;
}

// Add a slot to a day's slots array (default: append to end).
dataRoutes.post("/travel/itineraries/:id/days/:dayIndex/slots", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  const body = await c.req.json<{
    activity_id: string;
    start_time?: string;
    day_note?: string;
    notes?: string; // legacy alias for day_note
    position?: number;
  }>();
  if (!body.activity_id) return c.json({ error: "activity_id required" }, 400);

  const out = await mutateDays(pb, id, userId, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range (have ${days.length})` };
    const slot: ItinerarySlot = { activityId: body.activity_id };
    const startTime = canonicalSlotTime(body.start_time);
    if (startTime) slot.startTime = startTime;
    const dayNote = body.day_note ?? body.notes;
    if (dayNote) slot.dayNote = dayNote;
    const slots = days[dayIdx].slots;
    const pos = body.position ?? slots.length;
    const clamped = Math.max(0, Math.min(slots.length, pos));
    slots.splice(clamped, 0, slot);
    return { day_index: dayIdx, position: clamped, day: days[dayIdx] };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// Remove a slot from a day.
dataRoutes.delete("/travel/itineraries/:id/days/:dayIndex/slots/:slotIndex", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  const slotIdx = parseIdx(c.req.param("slotIndex"), "slot index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  if (typeof slotIdx === "object") return c.json({ error: slotIdx.error }, 400);

  const out = await mutateDays(pb, id, userId, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range` };
    const slots = days[dayIdx].slots;
    if (slotIdx >= slots.length) return { error: `slot index ${slotIdx} out of range` };
    const removed = slots.splice(slotIdx, 1)[0];
    return { day_index: dayIdx, removed, day: days[dayIdx] };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// Update a slot's fields (startTime, notes, activityId).
dataRoutes.patch("/travel/itineraries/:id/days/:dayIndex/slots/:slotIndex", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  const slotIdx = parseIdx(c.req.param("slotIndex"), "slot index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  if (typeof slotIdx === "object") return c.json({ error: slotIdx.error }, 400);
  const body = await c.req.json<{
    activity_id?: string;
    start_time?: string | null;
    day_note?: string | null;
    notes?: string | null; // legacy alias for day_note
  }>();

  const out = await mutateDays(pb, id, userId, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range` };
    const slots = days[dayIdx].slots;
    if (slotIdx >= slots.length) return { error: `slot index ${slotIdx} out of range` };
    const slot = slots[slotIdx];
    if (body.activity_id !== undefined) slot.activityId = body.activity_id;
    // null clears the optional field; undefined leaves it alone. Non-null
    // start_time is normalized to canonical HH:MM (an unparseable value clears).
    if (body.start_time === null) delete slot.startTime;
    else if (body.start_time !== undefined) {
      const canon = canonicalSlotTime(body.start_time);
      if (canon) slot.startTime = canon;
      else delete slot.startTime;
    }
    const dayNote = body.day_note !== undefined ? body.day_note : body.notes;
    if (dayNote === null) delete slot.dayNote;
    else if (dayNote !== undefined) slot.dayNote = dayNote;
    return { day_index: dayIdx, slot_index: slotIdx, day: days[dayIdx] };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// Update a day's metadata (label, date, lodging).
dataRoutes.patch("/travel/itineraries/:id/days/:dayIndex", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  const body = await c.req.json<{
    label?: string;
    date?: string | null;
    lodging_activity_id?: string | null;
  }>();

  const out = await mutateDays(pb, id, userId, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range` };
    const day = days[dayIdx];
    if (body.label !== undefined) day.label = body.label;
    if (body.date === null) delete day.date;
    else if (body.date !== undefined) day.date = body.date;
    if (body.lodging_activity_id === null) delete day.lodgingActivityId;
    else if (body.lodging_activity_id !== undefined) day.lodgingActivityId = body.lodging_activity_id;
    return { day_index: dayIdx, day };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// Move a slot — within a day (reorder) or to a different day (transfer).
dataRoutes.post("/travel/itineraries/:id/days/:dayIndex/slots/:slotIndex/move", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const fromDay = parseIdx(c.req.param("dayIndex"), "day index");
  const fromSlot = parseIdx(c.req.param("slotIndex"), "slot index");
  if (typeof fromDay === "object") return c.json({ error: fromDay.error }, 400);
  if (typeof fromSlot === "object") return c.json({ error: fromSlot.error }, 400);
  const body = await c.req.json<{ to_day_index: number; to_position?: number }>();
  if (typeof body.to_day_index !== "number") return c.json({ error: "to_day_index required" }, 400);

  const out = await mutateDays(pb, id, userId, (days) => {
    if (fromDay >= days.length) return { error: `from day_index ${fromDay} out of range` };
    if (body.to_day_index >= days.length) return { error: `to_day_index ${body.to_day_index} out of range` };
    const fromSlots = days[fromDay].slots;
    if (fromSlot >= fromSlots.length) return { error: `slot index ${fromSlot} out of range` };
    const slot = fromSlots.splice(fromSlot, 1)[0];
    const toSlots = days[body.to_day_index].slots;
    // If reordering within the same day after splice, the target indices have shifted —
    // but because we removed first and `splice` mutates in place, toSlots reflects the
    // post-removal state, so to_position is interpreted against that.
    const pos = body.to_position ?? toSlots.length;
    const clamped = Math.max(0, Math.min(toSlots.length, pos));
    toSlots.splice(clamped, 0, slot);
    return {
      from_day_index: fromDay,
      to_day_index: body.to_day_index,
      to_position: clamped,
      from_day: days[fromDay],
      to_day: days[body.to_day_index],
    };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// ── Day-level ops (add / remove / move whole days) ──────────────

// Insert a new day. Position defaults to end of the days array.
dataRoutes.post("/travel/itineraries/:id/days", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const body = await c.req.json<{
    label: string;
    date?: string;
    lodging_activity_id?: string;
    position?: number;
  }>();
  if (!body.label) return c.json({ error: "label required" }, 400);

  const out = await mutateDays(pb, id, userId, (days) => {
    const day: ItineraryDay = { label: body.label, slots: [] };
    if (body.date) day.date = body.date;
    if (body.lodging_activity_id) day.lodgingActivityId = body.lodging_activity_id;
    const pos = body.position ?? days.length;
    const clamped = Math.max(0, Math.min(days.length, pos));
    days.splice(clamped, 0, day);
    return { day_index: clamped, day, days_count: days.length };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// Remove a day (cascades any slots/flights it contained).
dataRoutes.delete("/travel/itineraries/:id/days/:dayIndex", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);

  const out = await mutateDays(pb, id, userId, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range` };
    const removed = days.splice(dayIdx, 1)[0];
    return { day_index: dayIdx, removed, days_count: days.length };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// Move a whole day to a different position (reordering).
dataRoutes.post("/travel/itineraries/:id/days/:dayIndex/move", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  const body = await c.req.json<{ to_position: number }>();
  if (typeof body.to_position !== "number") return c.json({ error: "to_position required" }, 400);

  const out = await mutateDays(pb, id, userId, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range` };
    const [day] = days.splice(dayIdx, 1);
    const clamped = Math.max(0, Math.min(days.length, body.to_position));
    days.splice(clamped, 0, day);
    return { from_day_index: dayIdx, to_day_index: clamped, days_count: days.length };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// ── Flight-slot ops (parity with regular slot ops) ──────────────
// Days have a separate `flights[]` array for major transport. These ops
// mirror the slot ops exactly but operate on day.flights.

function getFlights(day: ItineraryDay): ItinerarySlot[] {
  if (!day.flights) day.flights = [];
  return day.flights;
}

// Add a flight to a day's flights (default: append to end).
dataRoutes.post("/travel/itineraries/:id/days/:dayIndex/flights", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  const body = await c.req.json<{
    activity_id: string;
    start_time?: string;
    day_note?: string;
    notes?: string; // legacy alias for day_note
    position?: number;
  }>();
  if (!body.activity_id) return c.json({ error: "activity_id required" }, 400);

  const out = await mutateDays(pb, id, userId, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range` };
    const flight: ItinerarySlot = { activityId: body.activity_id };
    const startTime = canonicalSlotTime(body.start_time);
    if (startTime) flight.startTime = startTime;
    const dayNote = body.day_note ?? body.notes;
    if (dayNote) flight.dayNote = dayNote;
    const flights = getFlights(days[dayIdx]);
    const pos = body.position ?? flights.length;
    const clamped = Math.max(0, Math.min(flights.length, pos));
    flights.splice(clamped, 0, flight);
    return { day_index: dayIdx, position: clamped, day: days[dayIdx] };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// Remove a flight by index.
dataRoutes.delete("/travel/itineraries/:id/days/:dayIndex/flights/:flightIndex", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  const flightIdx = parseIdx(c.req.param("flightIndex"), "flight index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  if (typeof flightIdx === "object") return c.json({ error: flightIdx.error }, 400);

  const out = await mutateDays(pb, id, userId, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range` };
    const flights = getFlights(days[dayIdx]);
    if (flightIdx >= flights.length) return { error: `flight index ${flightIdx} out of range` };
    const removed = flights.splice(flightIdx, 1)[0];
    return { day_index: dayIdx, removed, day: days[dayIdx] };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// Update a flight's fields.
dataRoutes.patch("/travel/itineraries/:id/days/:dayIndex/flights/:flightIndex", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  const flightIdx = parseIdx(c.req.param("flightIndex"), "flight index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  if (typeof flightIdx === "object") return c.json({ error: flightIdx.error }, 400);
  const body = await c.req.json<{
    activity_id?: string;
    start_time?: string | null;
    day_note?: string | null;
    notes?: string | null; // legacy alias for day_note
  }>();

  const out = await mutateDays(pb, id, userId, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range` };
    const flights = getFlights(days[dayIdx]);
    if (flightIdx >= flights.length) return { error: `flight index ${flightIdx} out of range` };
    const flight = flights[flightIdx];
    if (body.activity_id !== undefined) flight.activityId = body.activity_id;
    if (body.start_time === null) delete flight.startTime;
    else if (body.start_time !== undefined) {
      const canon = canonicalSlotTime(body.start_time);
      if (canon) flight.startTime = canon;
      else delete flight.startTime;
    }
    const dayNote = body.day_note !== undefined ? body.day_note : body.notes;
    if (dayNote === null) delete flight.dayNote;
    else if (dayNote !== undefined) flight.dayNote = dayNote;
    return { day_index: dayIdx, flight_index: flightIdx, day: days[dayIdx] };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// Move a flight — reorder within a day or transfer between days.
dataRoutes.post("/travel/itineraries/:id/days/:dayIndex/flights/:flightIndex/move", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const fromDay = parseIdx(c.req.param("dayIndex"), "day index");
  const fromFlight = parseIdx(c.req.param("flightIndex"), "flight index");
  if (typeof fromDay === "object") return c.json({ error: fromDay.error }, 400);
  if (typeof fromFlight === "object") return c.json({ error: fromFlight.error }, 400);
  const body = await c.req.json<{ to_day_index: number; to_position?: number }>();
  if (typeof body.to_day_index !== "number") return c.json({ error: "to_day_index required" }, 400);

  const out = await mutateDays(pb, id, userId, (days) => {
    if (fromDay >= days.length) return { error: `from day_index ${fromDay} out of range` };
    if (body.to_day_index >= days.length) return { error: `to_day_index ${body.to_day_index} out of range` };
    const fromFlights = getFlights(days[fromDay]);
    if (fromFlight >= fromFlights.length) return { error: `flight index ${fromFlight} out of range` };
    const flight = fromFlights.splice(fromFlight, 1)[0];
    const toFlights = getFlights(days[body.to_day_index]);
    const pos = body.to_position ?? toFlights.length;
    const clamped = Math.max(0, Math.min(toFlights.length, pos));
    toFlights.splice(clamped, 0, flight);
    return {
      from_day_index: fromDay,
      to_day_index: body.to_day_index,
      to_position: clamped,
      from_day: days[fromDay],
      to_day: days[body.to_day_index],
    };
  });
  if ("error" in out) return c.json({ error: out.error }, out.status as 400 | 403 | 404);
  return c.json(out.result);
}));

// ---- Travel notes (per-user feedback) ----
//
// Notes are append-rows under a travel_log, one per author, tied to a
// subject (`activity | day | trip`). `created_by` is the author and is
// ALWAYS stamped server-side from the token identity — a client cannot set
// it. Authorization mirrors the cooking-log pattern: every op gates on
// LOG OWNERSHIP (any co-owner can edit/delete), not on created_by match.

// List notes for a subject. Read-gated on log ownership (same as the rest of
// the travel surface — the route layer is the only gate, admin-PB bypasses
// PB rules).
dataRoutes.get("/travel/notes", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const logId = c.req.query("log");
  const subjectType = c.req.query("subject_type");
  const subjectId = c.req.query("subject_id");
  if (!logId || !subjectType || !subjectId) {
    return c.json({ error: "log, subject_type, and subject_id query params required" }, 400);
  }
  if (!(NOTE_SUBJECT_TYPES as readonly string[]).includes(subjectType)) {
    return c.json({ error: `subject_type must be one of ${NOTE_SUBJECT_TYPES.join(", ")}` }, 400);
  }
  if (!(await userOwnsTravelLog(pb, logId, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const notes = await pb.collection("travel_notes").getFullList({
    filter: pb.filter(
      "log = {:logId} && subject_type = {:subjectType} && subject_id = {:subjectId}",
      { logId, subjectType, subjectId },
    ),
    sort: "-created",
  });
  return c.json(notes.map((n) => ({
    id: n.id,
    log: n.log,
    subject_type: n.subject_type,
    subject_id: n.subject_id,
    created_by: n.created_by,
    entries: n.entries,
    created: n.created,
    updated: n.updated,
  })));
}));

// Create a note. `created_by` is stamped from the token identity — any
// client-supplied created_by in the body is IGNORED.
dataRoutes.post("/travel/notes", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  type PostBody = { log?: string; subject_type?: string; subject_id?: string; entries?: unknown };
  const body = await c.req.json<PostBody>().catch(() => ({} as PostBody));
  if (!body.log || !body.subject_type || !body.subject_id) {
    return c.json({ error: "log, subject_type, and subject_id required" }, 400);
  }
  if (!(NOTE_SUBJECT_TYPES as readonly string[]).includes(body.subject_type)) {
    return c.json({ error: `subject_type must be one of ${NOTE_SUBJECT_TYPES.join(", ")}` }, 400);
  }
  if (!validNoteEntries(body.entries)) {
    return c.json({ error: "entries must be an array of {name,type,value,...} LifeEntry objects" }, 400);
  }
  if (!(await userOwnsTravelLog(pb, body.log, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const record = await pb.collection("travel_notes").create({
    log: body.log,
    subject_type: body.subject_type,
    subject_id: body.subject_id,
    // Author is the authenticated caller — never the body.
    created_by: userId,
    entries: body.entries,
  });
  return c.json({
    id: record.id,
    log: record.log,
    subject_type: record.subject_type,
    subject_id: record.subject_id,
    created_by: record.created_by,
    entries: record.entries,
    created: record.created,
  }, 201);
}));

// Update a note's entries (wholesale replace). Authorization resolves the
// note's parent log first, then gates on ownership. created_by / subject_* /
// log are NOT mutable here — only `entries`.
//
// TODO(author-only): a future phase may tighten edit/delete to the note's
// own author (created_by == caller) rather than any co-owner of the log.
// Today it intentionally matches the cooking-log gate (log ownership).
dataRoutes.patch("/travel/notes/:noteId", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const noteId = c.req.param("noteId")!;
  const record = await pb.collection("travel_notes").getOne(noteId).catch(() => null);
  if (!record) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, record.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const body = await c.req.json<{ entries?: unknown }>().catch(() => ({} as { entries?: unknown }));
  if (!validNoteEntries(body.entries)) {
    return c.json({ error: "entries must be an array of {name,type,value,...} LifeEntry objects" }, 400);
  }
  // Only `entries` is writable — created_by / subject_* / log stay put.
  const updated = await pb.collection("travel_notes").update(noteId, { entries: body.entries });
  return c.json({
    id: updated.id,
    log: updated.log,
    subject_type: updated.subject_type,
    subject_id: updated.subject_id,
    created_by: updated.created_by,
    entries: updated.entries,
    created: updated.created,
    updated: updated.updated,
  });
}));

// Delete a note. Same log-ownership gate as PATCH.
//
// TODO(author-only): see the PATCH note above — may tighten to author-only.
dataRoutes.delete("/travel/notes/:noteId", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const noteId = c.req.param("noteId")!;
  const record = await pb.collection("travel_notes").getOne(noteId).catch(() => null);
  if (!record) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, record.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  await pb.collection("travel_notes").delete(noteId);
  return c.json({ success: true });
}));

// ---- Life ----

// Get the user's life log
dataRoutes.get("/life/log", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  // life_logs is single-owner (migration 0028); the back-pointer is the
  // source of truth now that users.life_log_id is gone (0029).
  const logs = await pb.collection("life_logs").getList(1, 1, {
    filter: pb.filter("owner = {:uid}", { uid: userId }),
    sort: "created",
  });
  if (logs.items.length === 0) return c.json({ error: "no life log configured" }, 404);
  const log = logs.items[0];
  // Note: this route deliberately does NOT return `manifest`. The per-user
  // trackable manifest lives on the life_logs.manifest JSON column (re-added by
  // 20260601_191856_life_manifest_column.js and written by the P4 trackable
  // ops) and is read/mutated via the dedicated /life/trackables routes below —
  // do not prune that write path on the assumption the column is dead. The api
  // scheduler reads RANDOM_SAMPLES from @homelab/backend directly.
  return c.json({
    id: log.id,
    name: log.name,
    sample_schedule: log.sample_schedule,
  });
}));

// List events in a life log (the wire term remains `entries` for URL stability).
dataRoutes.get("/life/entries", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const logId = c.req.query("log");
  if (!logId) return c.json({ error: "log query param required" }, 400);
  if (!(await userOwnsLifeLog(pb, logId, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const events = await pb.collection("life_events").getFullList({
    filter: pb.filter("log = {:logId}", { logId }),
    sort: "-timestamp",
  });
  return c.json(events.map((e) => ({
    id: e.id,
    log: e.log,
    subject_id: e.subject_id,
    timestamp: e.timestamp,
    end_time: e.end_time || null,
    entries: e.entries || [],
    labels: e.labels || null,
    created_by: e.created_by,
  })));
}));

// Create a life event. The wire shape mirrors the new LifeBackend.addEvent:
// the caller provides the entries[] array directly, plus optional labels and
// end_time. Legacy `data`/`notes` fields are no longer accepted — callers must
// construct typed entries.
dataRoutes.post("/life/entries", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{
    log: string;
    subject_id?: string;
    /** Legacy alias for subject_id from the old wire format. */
    widget_id?: string;
    entries?: unknown[];
    labels?: Record<string, string>;
    timestamp?: string;
    end_time?: string;
  }>();
  const subjectId = body.subject_id || body.widget_id;
  if (!body.log || !subjectId) {
    return c.json({ error: "log and subject_id required" }, 400);
  }
  if (!(await userOwnsLifeLog(pb, body.log, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const entries = Array.isArray(body.entries) ? body.entries : [];
  // Mirror the LifeBackend invariant (see packages/backend/src/pocketbase/life.ts
  // addEvent + apps/life/DATA_COLLECTION.md F1): empty-payload events
  // poison observation aggregates and are almost always bugs. The MCP
  // path lands here directly (it doesn't go through the frontend backend
  // adapter), so the guard has to live in both places.
  if (entries.length === 0) {
    return c.json({ error: "entries[] must contain at least one entry" }, 400);
  }

  const payload: Record<string, unknown> = {
    log: body.log,
    subject_id: subjectId,
    timestamp: body.timestamp || new Date().toISOString(),
    created_by: userId,
    entries,
  };
  if (body.end_time) payload.end_time = body.end_time;
  if (body.labels && Object.keys(body.labels).length > 0) payload.labels = body.labels;

  const record = await pb.collection("life_events").create(payload);
  return c.json({ id: record.id, timestamp: record.timestamp }, 201);
}));

// Update a life event — timestamp, end_time, entries (whole-replace), or
// labels (whole-replace). No merge semantics — callers send the new value.
dataRoutes.patch("/life/entries/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const body = await c.req.json<{
    timestamp?: string;
    end_time?: string | null;
    entries?: unknown[];
    labels?: Record<string, string> | null;
  }>();
  const record = await pb.collection("life_events").getOne(id).catch(() => null);
  if (!record) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsLifeLog(pb, record.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  // Mirror the LifeBackend invariant (see packages/backend/src/pocketbase/life.ts
  // updateEvent + apps/life/DATA_COLLECTION.md F1): if the caller is
  // *setting* entries, the new value must be a non-empty array. Omit the
  // field entirely to leave entries unchanged (e.g. timestamp-only edits).
  // The MCP `update_life_entry` tool wraps this route, so without the guard
  // a scripted `update_life_entry({id, entries: []})` would re-introduce
  // exactly the empty-payload rows the original audit eliminated.
  if (body.entries !== undefined && (!Array.isArray(body.entries) || body.entries.length === 0)) {
    return c.json({ error: "entries[] must contain at least one entry when set" }, 400);
  }
  const patch: Record<string, unknown> = {};
  if (body.timestamp) patch.timestamp = body.timestamp;
  if (body.end_time !== undefined) patch.end_time = body.end_time;
  if (body.entries !== undefined) patch.entries = body.entries;
  if (body.labels !== undefined) patch.labels = body.labels;
  if (Object.keys(patch).length === 0) return c.json({ error: "no fields provided" }, 400);

  const updated = await pb.collection("life_events").update(id, patch);
  return c.json({
    id: updated.id,
    timestamp: updated.timestamp,
    entries: updated.entries || [],
    labels: updated.labels || null,
  });
}));

// Delete a life log entry
dataRoutes.delete("/life/entries/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const record = await pb.collection("life_events").getOne(id).catch(() => null);
  if (!record) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsLifeLog(pb, record.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  await pb.collection("life_events").delete(id);
  return c.json({ success: true });
}));

// ---- Life trackable manifest (P4) ----
//
// Server-side CRUD over the per-user `life_logs.manifest` JSON column. The
// validation + mutation rules are the canonical pure ops in
// @homelab/backend/life-manifest-ops; this layer only does identity scoping
// (resolve the CALLER'S OWN log from userId — never a caller-supplied log id,
// so cross-user writes are structurally impossible) and a read-modify-write of
// the manifest column. Removal is manifest-only and never touches life_events.

/** Coerce a PB `manifest` JSON value into a LifeManifest, or null. */
function manifestFromValue(raw: unknown): LifeManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (!Array.isArray(m.trackables)) return null;
  const out: LifeManifest = { trackables: m.trackables as LifeManifest["trackables"] };
  // Carry the optional goals[] layer through so a goal mutation reads + writes
  // the freshest list (the pure ops validate on write).
  if (Array.isArray(m.goals)) out.goals = m.goals as LifeManifest["goals"];
  // Carry `views` / `notifications` (Unified Capture) through verbatim — a
  // read-modify-write of one manifest key must not drop the others. An explicit
  // `[]` is LOAD-BEARING (means "explicitly none", distinct from `undefined` →
  // the DEFAULT_* fallback), so we preserve `[]` rather than coercing it to
  // undefined. Mirrors the PB mapper in packages/backend/src/pocketbase/life.ts.
  if (Array.isArray(m.views)) out.views = m.views as LifeManifest["views"];
  if (Array.isArray(m.notifications))
    out.notifications = m.notifications as LifeManifest["notifications"];
  return out;
}

/**
 * Resolve the caller's OWN life log, creating it (seeded with the default
 * starter manifest) if absent. Returns the raw PB record. This is the identity
 * gate for every trackable op — the manifest is always the caller's own,
 * resolved from the token's userId, so there is no caller-supplied log id to
 * attack with.
 */
async function getOrCreateOwnLifeLog(pb: PocketBase, userId: string) {
  const logs = await pb.collection("life_logs").getList(1, 1, {
    filter: pb.filter("owner = {:uid}", { uid: userId }),
    sort: "created",
  });
  if (logs.items.length > 0) return logs.items[0];
  return pb.collection("life_logs").create({
    name: "Life Log",
    owner: userId,
    manifest: defaultLifeManifest(),
    // Coach defaults ON. PB bool fields schema-default to `false`, and the
    // mapper's `?? true` only rescues a genuinely-absent column — so a row
    // created without this key reads back `false`. Seed it true explicitly.
    coach_enabled: true,
  });
}

/** Map a ManifestError code to an HTTP status. */
function manifestErrorStatus(code: ManifestError["code"]): 400 | 404 | 409 {
  if (code === "not_found" || code === "goal_not_found" || code === "view_not_found" || code === "notification_not_found") {
    return 404;
  }
  if (code === "duplicate_id" || code === "duplicate_goal" || code === "duplicate_view" || code === "duplicate_notification") {
    return 409;
  }
  return 400;
}

/**
 * Run a pure manifest mutation against the caller's own log and persist it.
 * `mutate` throws ManifestError on invalid input → translated to a clean HTTP
 * status. Returns the persisted manifest as the response body.
 */
async function applyManifestMutation(
  pb: PocketBase,
  userId: string,
  mutate: (current: LifeManifest) => LifeManifest,
): Promise<{ ok: true; manifest: LifeManifest } | { ok: false; status: 400 | 404 | 409; error: string }> {
  const log = await getOrCreateOwnLifeLog(pb, userId);
  const current = manifestFromValue(log.manifest) ?? emptyManifest();
  let next: LifeManifest;
  try {
    next = mutate(current);
  } catch (e) {
    if (e instanceof ManifestError) {
      return { ok: false, status: manifestErrorStatus(e.code), error: e.message };
    }
    throw e;
  }
  await pb.collection("life_logs").update(log.id, { manifest: next });
  return { ok: true, manifest: next };
}

// List the caller's trackables.
dataRoutes.get("/life/trackables", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const log = await getOrCreateOwnLifeLog(pb, userId);
  const manifest = manifestFromValue(log.manifest) ?? emptyManifest();
  return c.json({ log: log.id, trackables: manifest.trackables });
}));

// Add a vocab row to the caller's manifest.
dataRoutes.post("/life/trackables", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{
    id?: string;
    label?: string;
    shape?: string;
    group?: string;
    hidden?: boolean;
    defaultUnit?: unknown;
    defaultAmount?: unknown;
    defaultDuration?: unknown;
    ratingLabel?: unknown;
    pinned?: unknown;
    prompt?: unknown;
    hint?: unknown;
    placeholder?: unknown;
    refs?: unknown;
  }>();
  if (typeof body.id !== "string" || typeof body.label !== "string" || typeof body.shape !== "string") {
    return c.json({ error: "id, label, and shape are required strings" }, 400);
  }
  const out = await applyManifestMutation(pb, userId, (cur) =>
    addTrackableOp(cur, {
      id: body.id as string,
      label: body.label as string,
      shape: body.shape as string,
      group: body.group,
      hidden: body.hidden,
      defaultUnit: body.defaultUnit,
      defaultAmount: body.defaultAmount,
      defaultDuration: body.defaultDuration,
      ratingLabel: body.ratingLabel,
      pinned: body.pinned,
      prompt: body.prompt,
      hint: body.hint,
      placeholder: body.placeholder,
      refs: body.refs,
    }),
  );
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ trackables: out.manifest.trackables }, 201);
}));

// Patch a trackable. id + shape are immutable — STRUCTURALLY (the pure op's
// patch type is the payload keyspace, so they can't be passed at all).
dataRoutes.patch("/life/trackables/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const trackableId = c.req.param("id")!;
  const body = await c.req.json<{
    label?: string;
    group?: string | null;
    hidden?: boolean;
    defaultUnit?: unknown;
    defaultAmount?: unknown;
    defaultDuration?: unknown;
    ratingLabel?: unknown;
    pinned?: unknown;
    prompt?: unknown;
    hint?: unknown;
    placeholder?: unknown;
    refs?: unknown;
  }>();
  const out = await applyManifestMutation(pb, userId, (cur) =>
    // The pure op's patch type is the trackable's PAYLOAD keyspace, so `id` /
    // `shape` are structurally unnameable here — immutability is enforced by the
    // type system, not a runtime throw. A caller's `id`/`shape` in the body is
    // simply not forwarded (it can't be).
    updateTrackableOp(cur, trackableId, {
      label: body.label,
      group: body.group,
      hidden: body.hidden,
      defaultUnit: body.defaultUnit,
      defaultAmount: body.defaultAmount,
      defaultDuration: body.defaultDuration,
      ratingLabel: body.ratingLabel,
      pinned: body.pinned,
      prompt: body.prompt,
      hint: body.hint,
      placeholder: body.placeholder,
      refs: body.refs,
    }),
  );
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ trackables: out.manifest.trackables });
}));

// Remove a trackable (manifest-only — never deletes life_events).
dataRoutes.delete("/life/trackables/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const trackableId = c.req.param("id")!;
  const out = await applyManifestMutation(pb, userId, (cur) => removeTrackableOp(cur, trackableId));
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ success: true, trackables: out.manifest.trackables });
}));

// Reorder trackables. order[] must be a permutation of the current ids.
dataRoutes.post("/life/trackables/reorder", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{ order?: unknown }>();
  const out = await applyManifestMutation(pb, userId, (cur) => reorderTrackablesOp(cur, body.order));
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ trackables: out.manifest.trackables });
}));

// Set a trackable's pins wholesale (validated against its fields).
dataRoutes.put("/life/trackables/:id/pins", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const trackableId = c.req.param("id")!;
  const body = await c.req.json<{ pinned?: unknown }>();
  const out = await applyManifestMutation(pb, userId, (cur) => setPinsOp(cur, trackableId, body.pinned ?? []));
  if (!out.ok) return c.json({ error: out.error }, out.status);
  const t = out.manifest.trackables.find((x) => x.id === trackableId);
  return c.json({ pinned: t?.pinned ?? [] });
}));

// ---- Life goals (thin interpretive layer over events; manifest-only) ----
//
// Same identity scoping + read-modify-write pattern as the trackable routes:
// resolve the CALLER'S OWN log (never a caller-supplied id), run a pure goal op
// from @homelab/backend, persist the whole manifest. Goals add no event data —
// removal/edit never touches life_events. The pure ops enforce all validation
// (frequency⇒days, sum⇒unit, immutable id/scope/kind/metric).

// List the caller's goals.
dataRoutes.get("/life/goals", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const log = await getOrCreateOwnLifeLog(pb, userId);
  const manifest = manifestFromValue(log.manifest) ?? emptyManifest();
  return c.json({ log: log.id, goals: manifestGoals(manifest) });
}));

// Add a goal to the caller's manifest.
dataRoutes.post("/life/goals", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{
    id?: unknown;
    label?: unknown;
    scope?: unknown;
    kind?: unknown;
    metric?: unknown;
    target?: unknown;
    unit?: unknown;
    period?: unknown;
    hidden?: unknown;
  }>();
  if (typeof body.id !== "string") {
    return c.json({ error: "id is required (a slug string)" }, 400);
  }
  const out = await applyManifestMutation(pb, userId, (cur) =>
    addGoalOp(cur, {
      id: body.id as string,
      label: body.label,
      scope: body.scope,
      kind: body.kind,
      metric: body.metric,
      target: body.target,
      unit: body.unit,
      period: body.period,
      hidden: body.hidden,
    }),
  );
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ goals: manifestGoals(out.manifest) }, 201);
}));

// Patch a goal. id/scope/kind/metric are immutable — STRUCTURALLY (the pure
// op's patch type is the payload keyspace, so they can't be passed at all).
dataRoutes.patch("/life/goals/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const goalId = c.req.param("id")!;
  const body = await c.req.json<{
    label?: unknown;
    target?: unknown;
    unit?: unknown;
    period?: unknown;
    hidden?: unknown;
  }>();
  const out = await applyManifestMutation(pb, userId, (cur) =>
    updateGoalOp(cur, goalId, {
      label: body.label,
      target: body.target,
      unit: body.unit,
      period: body.period,
      hidden: body.hidden,
    }),
  );
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ goals: manifestGoals(out.manifest) });
}));

// Remove a goal (manifest-only — never deletes life_events).
dataRoutes.delete("/life/goals/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const goalId = c.req.param("id")!;
  const out = await applyManifestMutation(pb, userId, (cur) => removeGoalOp(cur, goalId));
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ success: true, goals: manifestGoals(out.manifest) });
}));

// Reorder goals. order[] must be a permutation of the current goal ids.
dataRoutes.post("/life/goals/reorder", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{ order?: unknown }>();
  const out = await applyManifestMutation(pb, userId, (cur) => reorderGoalsOp(cur, body.order));
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ goals: manifestGoals(out.manifest) });
}));

// ---- Life views (Unified Capture; manifest-only) ----
//
// Same identity scoping + read-modify-write pattern as the trackable/goal
// routes: resolve the CALLER'S OWN log, run a pure view op, persist the whole
// manifest. Views add no event data. `id` is IMMUTABLE (written to
// life_events.labels.view). The pure ops enforce all validation.

// List the caller's views.
dataRoutes.get("/life/views", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const log = await getOrCreateOwnLifeLog(pb, userId);
  const manifest = manifestFromValue(log.manifest) ?? emptyManifest();
  return c.json({ log: log.id, views: manifestViews(manifest) });
}));

// Add a view to the caller's manifest.
dataRoutes.post("/life/views", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{
    id?: unknown;
    title?: unknown;
    greeting?: unknown;
    icon?: unknown;
    render?: unknown;
    items?: unknown;
  }>();
  if (typeof body.id !== "string") {
    return c.json({ error: "id is required (a slug string)" }, 400);
  }
  const out = await applyManifestMutation(pb, userId, (cur) =>
    addViewOp(cur, {
      id: body.id as string,
      title: body.title,
      greeting: body.greeting,
      icon: body.icon,
      render: body.render,
      items: body.items,
    }),
  );
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ views: manifestViews(out.manifest) }, 201);
}));

// Patch a view. id is immutable — STRUCTURALLY (the pure op's patch type is the
// payload keyspace, so it can't be passed at all).
dataRoutes.patch("/life/views/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const viewId = c.req.param("id")!;
  const body = await c.req.json<{
    title?: unknown;
    greeting?: unknown;
    icon?: unknown;
    render?: unknown;
    items?: unknown;
  }>();
  const out = await applyManifestMutation(pb, userId, (cur) =>
    updateViewOp(cur, viewId, {
      title: body.title,
      greeting: body.greeting,
      icon: body.icon,
      render: body.render,
      items: body.items,
    }),
  );
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ views: manifestViews(out.manifest) });
}));

// Remove a view (manifest-only — never deletes life_events).
dataRoutes.delete("/life/views/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const viewId = c.req.param("id")!;
  const out = await applyManifestMutation(pb, userId, (cur) => removeViewOp(cur, viewId));
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ success: true, views: manifestViews(out.manifest) });
}));

// Reorder views. order[] must be a permutation of the current view ids.
dataRoutes.post("/life/views/reorder", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{ order?: unknown }>();
  const out = await applyManifestMutation(pb, userId, (cur) => reorderViewsOp(cur, body.order));
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ views: manifestViews(out.manifest) });
}));

// ---- Life notifications (Unified Capture; manifest-only) ----
//
// Same pattern. A notification defines WHEN to open a View. `id` is IMMUTABLE
// (it keys reminder_state — the double-fire guard); `strategy.kind` is also
// immutable (it decides how the notification fires). The pure ops validate
// strategy by kind (fixed cadence/time/weekday/subsumes vs random
// timesPerDay/activeHours).

// List the caller's notifications.
dataRoutes.get("/life/notifications", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const log = await getOrCreateOwnLifeLog(pb, userId);
  const manifest = manifestFromValue(log.manifest) ?? emptyManifest();
  return c.json({ log: log.id, notifications: manifestNotifications(manifest) });
}));

// Add a notification to the caller's manifest.
dataRoutes.post("/life/notifications", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{
    id?: unknown;
    target?: unknown;
    strategy?: unknown;
    enabled?: unknown;
    title?: unknown;
    body?: unknown;
  }>();
  if (typeof body.id !== "string") {
    return c.json({ error: "id is required (a slug string)" }, 400);
  }
  const out = await applyManifestMutation(pb, userId, (cur) =>
    addNotificationOp(cur, {
      id: body.id as string,
      target: body.target,
      strategy: body.strategy,
      enabled: body.enabled,
      title: body.title,
      body: body.body,
    }),
  );
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ notifications: manifestNotifications(out.manifest) }, 201);
}));

// Patch a notification. id + strategy.kind are immutable (enforced in pure op).
dataRoutes.patch("/life/notifications/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const notificationId = c.req.param("id")!;
  const reqBody = await c.req.json<{
    id?: unknown;
    target?: unknown;
    strategy?: unknown;
    enabled?: unknown;
    title?: unknown;
    body?: unknown;
  }>();
  const out = await applyManifestMutation(pb, userId, (cur) =>
    // Forward `id` so the pure op rejects any rename attempt.
    updateNotificationOp(cur, notificationId, {
      id: reqBody.id as string | undefined,
      target: reqBody.target,
      strategy: reqBody.strategy,
      enabled: reqBody.enabled,
      title: reqBody.title,
      body: reqBody.body,
    }),
  );
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ notifications: manifestNotifications(out.manifest) });
}));

// Remove a notification (manifest-only — never deletes life_events).
dataRoutes.delete("/life/notifications/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const notificationId = c.req.param("id")!;
  const out = await applyManifestMutation(pb, userId, (cur) => removeNotificationOp(cur, notificationId));
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ success: true, notifications: manifestNotifications(out.manifest) });
}));

// Reorder notifications. order[] must be a permutation of the current ids.
dataRoutes.post("/life/notifications/reorder", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{ order?: unknown }>();
  const out = await applyManifestMutation(pb, userId, (cur) => reorderNotificationsOp(cur, body.order));
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ notifications: manifestNotifications(out.manifest) });
}));

// Evaluate every goal for its current period (default today) via the shared
// pure evaluator — the SAME evaluateGoal the HabitBoard uses, so chat-side
// adherence matches the dashboard exactly. Reads the caller's own log +
// events; never writes. `date` (ISO) overrides the ref date.
dataRoutes.get("/life/goals/progress", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const log = await getOrCreateOwnLifeLog(pb, userId);
  const manifest = manifestFromValue(log.manifest) ?? emptyManifest();
  const goals = manifestGoals(manifest);

  const refRaw = c.req.query("date");
  const refDate = refRaw ? new Date(refRaw) : new Date();
  if (Number.isNaN(refDate.getTime())) {
    return c.json({ error: "date must be a valid ISO datetime" }, 400);
  }

  // Resolve the log OWNER's timezone so server-side progress matches the
  // dashboard exactly (the pod runs UTC; the browser runs local — the evaluator
  // must compute every boundary in the owner's tz, not the runtime tz). Same
  // fallback the life notifier uses.
  let timeZone = "America/Los_Angeles";
  try {
    const owner = await pb.collection("users").getOne(log.owner as string);
    timeZone = safeTz(owner.timezone, "America/Los_Angeles");
  } catch {
    // owner unreadable → keep the fallback
  }

  // Pull the log's events into the LifeEvent shape the evaluator expects. The
  // evaluator only reads subjectId/timestamp/entries, but we build full rows so
  // the contract stays honest if it grows.
  const rows = await pb.collection("life_events").getFullList({
    filter: pb.filter("log = {:logId}", { logId: log.id }),
    sort: "-timestamp",
  });
  const events: LifeEvent[] = rows.map((e) => ({
    id: e.id,
    log: e.log as string,
    subjectId: (e.subject_id as string) || "",
    timestamp: new Date(e.timestamp as string),
    endTime: e.end_time ? new Date(e.end_time as string) : undefined,
    entries: Array.isArray(e.entries) ? (e.entries as LifeEvent["entries"]) : [],
    labels: (e.labels && typeof e.labels === "object" && !Array.isArray(e.labels))
      ? (e.labels as Record<string, string>)
      : undefined,
    createdBy: (e.created_by as string) || "",
    created: e.created as string,
    updated: e.updated as string,
  }));

  const progress = goals.map((goal) => {
    const p = evaluateGoal(goal, events, manifest.trackables, timeZone, refDate);
    return {
      id: goal.id,
      label: goal.label,
      kind: goal.kind,
      metric: goal.metric,
      unit: goal.unit,
      period: goal.period,
      value: p.value,
      target: p.target,
      met: p.met,
      remaining: p.remaining,
      streak: p.streak,
      period_start: p.periodStart.toISOString(),
      period_end: p.periodEnd.toISOString(),
    };
  });
  return c.json({ log: log.id, date: refDate.toISOString(), progress });
}));

// ---- Upkeep ----

// List task lists owned by the authenticated user. Tasks are scoped to a
// list, so callers (especially MCP clients) need this to discover list IDs
// before calling /tasks?list=…
dataRoutes.get("/task-lists", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const lists = await pb.collection("task_lists").getFullList({
    filter: pb.filter("owners ~ {:userId}", { userId }),
    sort: "name",
  });
  return c.json(lists.map((l) => ({ id: l.id, name: l.name })));
}));

// List tasks (supports filtering by parent_id, tag, task_type)
dataRoutes.get("/tasks", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const listId = c.req.query("list");
  if (!listId) return c.json({ error: "list query param required" }, 400);
  if (!(await userOwnsTaskList(pb, listId, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const filters = [pb.filter("list = {:listId}", { listId })];
  const parentId = c.req.query("parent_id");
  if (parentId !== undefined) filters.push(pb.filter("parent_id = {:parentId}", { parentId }));
  const tag = c.req.query("tag");
  if (tag) filters.push(pb.filter("tags ~ {:tag}", { tag }));
  const taskType = c.req.query("task_type");
  if (taskType) filters.push(pb.filter("task_type = {:taskType}", { taskType }));

  const tasks = await pb.collection("tasks").getFullList({
    filter: filters.join(" && "),
    sort: "position",
  });
  return c.json(tasks.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    parent_id: t.parent_id,
    path: t.path,
    position: t.position,
    task_type: t.task_type,
    frequency: t.frequency,
    last_completed: t.last_completed,
    deadline: t.deadline,
    deadline_lead_days: t.deadline_lead_days,
    completed: t.completed,
    snoozed_until: t.snoozed_until,
    tags: t.tags,
    collapsed: t.collapsed,
    cleared: t.cleared,
  })));
}));

// Create a task
dataRoutes.post("/tasks", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{
    list: string;
    name: string;
    description?: string;
    parent_id?: string;
    position?: number;
    task_type?: string;
    frequency?: unknown;
    tags?: string[];
    assignees?: string[];
    deadline?: string;
    deadline_lead_days?: number;
  }>();
  if (!body.list || !body.name) return c.json({ error: "list and name required" }, 400);
  if (!(await userOwnsTaskList(pb, body.list, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const record = await pb.collection("tasks").create({
    list: body.list,
    name: body.name,
    description: body.description || "",
    parent_id: body.parent_id || "",
    position: body.position ?? 0,
    task_type: body.task_type || "one_shot",
    frequency: body.frequency || 0,
    tags: body.tags || [],
    // assignees is the sole notification driver. Persist exactly what the
    // caller sent (empty when omitted) — do NOT stamp the creator here. Under
    // the inherit model an empty-assignees task resolves via the cascade:
    // nearest assigned ancestor (inherit) → else created_by (floor) → else
    // list.owners. So a task under an assigned container inherits that
    // assignee, and an unassigned task still notifies its creator via the floor.
    assignees: body.assignees ?? [],
    // Stamp the creator server-side from the authenticated identity (never
    // client-supplied). created_by is immutable provenance and the cascade's
    // terminal floor. UI-created tasks (home/upkeep backend) previously left
    // this empty.
    created_by: userId,
    deadline: body.deadline || null,
    deadline_lead_days: body.deadline_lead_days ?? null,
  });

  // Set path after creation (needs the ID)
  let path = record.id;
  if (body.parent_id) {
    const parent = await pb.collection("tasks").getOne(body.parent_id);
    path = `${parent.path}/${record.id}`;
  }
  await pb.collection("tasks").update(record.id, { path });

  return c.json({ id: record.id, name: record.name }, 201);
}));

// Update a task. parent_id and list are intentionally NOT allowed here —
// changing them must go through POST /tasks/:id/move so descendant `path`
// values get recomputed transactionally. PATCHing parent_id directly was a
// footgun that left stale subtree paths. The `allowed` allowlist also
// blocks reparent-via-PATCH attacks (`list`/`parent_id` aren't in it).
dataRoutes.patch("/tasks/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const existing = await pb.collection("tasks").getOne(id).catch(() => null);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTaskList(pb, existing.list as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const body = await c.req.json<Record<string, unknown>>();
  const allowed = ["name", "description", "task_type", "frequency", "position",
    "completed", "snoozed_until", "tags", "collapsed", "cleared", "assignees",
    "deadline", "deadline_lead_days"];
  const data: Record<string, unknown> = {};
  for (const key of allowed) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  const record = await pb.collection("tasks").update(id, data);
  return c.json({ id: record.id, name: record.name });
}));

// Move a task: change its parent (within or across lists) and/or position.
// Recomputes `path` on the task and all descendants so subtree filters stay
// correct. Pass new_parent_id="" (or null) to make it a root task.
//
// Ownership: caller must own BOTH the source list AND the destination list
// (if changed). Otherwise an attacker with their own list could steal any
// task by moving it into their own list.
dataRoutes.post("/tasks/:id/move", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const body = await c.req.json<{
    new_parent_id?: string | null;
    new_list?: string;
    position?: number;
  }>();

  const task = await pb.collection("tasks").getOne(id).catch(() => null);
  if (!task) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTaskList(pb, task.list as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  if (body.new_list !== undefined && body.new_list !== (task.list as string)) {
    if (!(await userOwnsTaskList(pb, body.new_list, userId))) {
      return c.json({ error: "access denied" }, 403);
    }
  }
  const oldPath = task.path as string;
  const newList = body.new_list ?? (task.list as string);

  let newParentId = "";
  let newPathPrefix = id; // root → path is just the id
  if (body.new_parent_id !== undefined && body.new_parent_id !== null && body.new_parent_id !== "") {
    const parent = await pb.collection("tasks").getOne(body.new_parent_id);
    if ((parent.list as string) !== newList) {
      return c.json({ error: "new_parent_id is in a different list than new_list" }, 400);
    }
    // Reject parent that's a descendant of this task (would create a cycle)
    if ((parent.path as string).startsWith(`${oldPath}/`) || parent.path === oldPath) {
      return c.json({ error: "cannot move a task under its own descendant" }, 400);
    }
    newParentId = parent.id;
    newPathPrefix = `${parent.path}/${id}`;
  } else if (body.new_parent_id === undefined) {
    // Caller didn't touch parent — keep current parent and current path prefix.
    newParentId = task.parent_id as string;
    newPathPrefix = oldPath;
  }

  const descendants = await pb.collection("tasks").getFullList({
    filter: pb.filter("path ~ {:prefix}", { prefix: `${oldPath}/%` }),
  });

  const taskUpdate: Record<string, unknown> = { path: newPathPrefix };
  if (body.new_parent_id !== undefined) taskUpdate.parent_id = newParentId;
  if (body.new_list !== undefined) taskUpdate.list = newList;
  if (body.position !== undefined) taskUpdate.position = body.position;
  await pb.collection("tasks").update(id, taskUpdate);

  // Rewrite each descendant's path (and list, if moving across lists).
  for (const d of descendants) {
    const descPath = d.path as string;
    const newDescPath = newPathPrefix + descPath.slice(oldPath.length);
    const update: Record<string, unknown> = { path: newDescPath };
    if (body.new_list !== undefined) update.list = newList;
    await pb.collection("tasks").update(d.id, update);
  }

  return c.json({
    id,
    parent_id: newParentId,
    list: newList,
    path: newPathPrefix,
    descendants_updated: descendants.length,
  });
}));

// Complete a task (recurring: adds a task_events record + refreshes
// last_completed; one_shot: toggles the completed flag)
dataRoutes.post("/tasks/:id/complete", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const task = await pb.collection("tasks").getOne(id).catch(() => null);
  if (!task) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTaskList(pb, task.list as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  if (task.task_type === "one_shot") {
    const record = await pb.collection("tasks").update(id, { completed: !task.completed });
    return c.json({ id: record.id, completed: record.completed });
  }

  const now = new Date().toISOString();
  await pb.collection("task_events").create({
    list: task.list,
    subject_id: id,
    timestamp: now,
    created_by: userId,
    entries: [],
  });
  // Recompute last_completed from the max event timestamp — keeps it honest
  // when events pre-date this one (backfills) or are later edited/deleted.
  const latestEvents = await pb.collection("task_events").getList(1, 1, {
    filter: pb.filter("subject_id = {:id}", { id }),
    sort: "-timestamp",
  });
  const latest = latestEvents.items[0]?.timestamp ?? now;
  const record = await pb.collection("tasks").update(id, {
    last_completed: latest,
    snoozed_until: "",
  });
  return c.json({ id: record.id, last_completed: record.last_completed });
}));

// Add and/or remove tags atomically without round-tripping through update_task.
// remove is applied first, then add — so re-tagging in one call does the right
// thing.
//
// The actual read-merge-write happens inside the transactional PB hook at
// POST /api/tasks/:id/tags (infra/pocketbase/pb_hooks/task_tags.pb.js); we
// forward there via pb.send() so the admin path inherits the same cross-device
// atomicity guarantee as the direct-PB path used by the wpb adapter. The hook
// bypasses its per-list ownership check for superuser callers — we do the
// userOwnsTaskList() check here first, before forwarding.
dataRoutes.post("/tasks/:id/tags", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const body = await c.req.json<{ add?: string[]; remove?: string[] }>();
  const add = body.add ?? [];
  const remove = body.remove ?? [];
  if (add.length === 0 && remove.length === 0) {
    return c.json({ error: "at least one of add[] / remove[] required" }, 400);
  }

  const task = await pb.collection("tasks").getOne(id).catch(() => null);
  if (!task) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTaskList(pb, task.list as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const result = await pb.send(`/api/tasks/${encodeURIComponent(id)}/tags`, {
    method: "POST",
    body: JSON.stringify({ add, remove }),
    headers: { "Content-Type": "application/json" },
  }) as { task?: { id: string; tags: string[] } };
  const taskOut = result.task ?? { id, tags: [] };
  return c.json({ id: taskOut.id, tags: taskOut.tags });
}));

// Snooze a task
dataRoutes.post("/tasks/:id/snooze", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const { until } = await c.req.json<{ until: string }>();
  if (!until) return c.json({ error: "until (ISO date) required" }, 400);
  const task = await pb.collection("tasks").getOne(id).catch(() => null);
  if (!task) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTaskList(pb, task.list as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  const record = await pb.collection("tasks").update(id, { snoozed_until: until });
  return c.json({ id: record.id, snoozed_until: record.snoozed_until });
}));

// Unsnooze a task (clear snoozed_until)
dataRoutes.post("/tasks/:id/unsnooze", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const task = await pb.collection("tasks").getOne(id).catch(() => null);
  if (!task) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTaskList(pb, task.list as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const record = await pb.collection("tasks").update(id, { snoozed_until: "" });
  return c.json({ id: record.id, snoozed_until: record.snoozed_until });
}));

// Soft-hide every completed, not-yet-cleared one_shot task in a list.
// Recurring tasks are excluded — they self-reset via last_completed, so
// "cleared" doesn't apply. Returns the count actually flipped (no-op safe).
dataRoutes.post("/tasks/lists/:listId/clear-done", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const listId = c.req.param("listId")!;
  if (!(await userOwnsTaskList(pb, listId, userId))) {
    return c.json({ error: "access denied" }, 403);
  }
  const targets = await pb.collection("tasks").getFullList({
    filter: pb.filter(
      "list = {:listId} && task_type = 'one_shot' && completed = true && cleared != true",
      { listId },
    ),
  });
  for (const t of targets) {
    await pb.collection("tasks").update(t.id, { cleared: true });
  }
  return c.json({ cleared_count: targets.length });
}));

// Delete a task (and all descendants)
dataRoutes.delete("/tasks/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const task = await pb.collection("tasks").getOne(id).catch(() => null);
  if (!task) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTaskList(pb, task.list as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  // Delete descendants first (deepest first)
  const descendants = await pb.collection("tasks").getFullList({
    filter: pb.filter("path ~ {:prefix}", { prefix: `${task.path}/%` }),
  });
  descendants.sort((a, b) => b.path.length - a.path.length);
  for (const d of descendants) {
    await pb.collection("tasks").delete(d.id);
  }
  await pb.collection("tasks").delete(id);
  return c.json({ deleted: true });
}));

// =============================================================================
// Monitor — deployment history
// =============================================================================

// `requireRole(c, "infra")` (imported from ../lib/authz) gates the
// global-infra writes below. Legitimate callers today: deploy.sh (records
// deployments via the EXIT trap) and event-watcher (records pod_events).
// Both are wired with the single `HOMELAB_API_TOKEN` from the k8s
// `api-secrets` Secret; that token's PB record needs `roles: ["infra"]`
// set once after migration 0025 ships (otherwise both writers will 403).
// User-minted Settings tokens, OAuth `mcpat_` tokens, and PB user JWTs
// never carry this role and are rejected with 403.

// Record a deployment. Called by infra/deploy.sh after each run.
dataRoutes.post("/deployments", handler(async (c) => {
  const denied = requireRole(c, "infra");
  if (denied) return denied;
  const pb = c.get("pb");
  const body = await c.req.json<{
    git_sha: string;
    git_branch?: string;
    git_subject?: string;
    apps?: string[];
    duration_seconds?: number;
    status: "success" | "failure" | "partial";
    deployer?: string;
    host?: string;
    notes?: string;
    failed_apps?: string[];
    // Channel discriminator: "prod" (default) or "beta". Lets the monitor
    // frontend partition deploy history when --beta is in use. See
    // pb_migrations/0030_deployments_variant.js.
    variant?: "prod" | "beta";
  }>();

  if (!body.git_sha || !body.status) {
    return c.json({ error: "git_sha and status required" }, 400);
  }
  if (!["success", "failure", "partial"].includes(body.status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  if (body.variant !== undefined && !["prod", "beta"].includes(body.variant)) {
    return c.json({ error: "invalid variant" }, 400);
  }

  const record = await pb.collection("deployments").create({
    git_sha: body.git_sha,
    git_branch: body.git_branch ?? "",
    git_subject: body.git_subject ?? "",
    apps: body.apps ?? [],
    duration_seconds: body.duration_seconds ?? 0,
    status: body.status,
    deployer: body.deployer ?? "",
    host: body.host ?? "",
    notes: body.notes ?? "",
    failed_apps: body.failed_apps ?? [],
    variant: body.variant ?? "prod",
  });
  return c.json({ id: record.id }, 201);
}));

// List recent deployments (newest first).
dataRoutes.get("/deployments", handler(async (c) => {
  const pb = c.get("pb");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 500);
  const records = await pb.collection("deployments").getList(1, limit, {
    sort: "-created",
  });
  return c.json(records.items.map((r) => ({
    id: r.id,
    created: r.created,
    git_sha: r.git_sha,
    git_branch: r.git_branch,
    git_subject: r.git_subject,
    apps: r.apps,
    duration_seconds: r.duration_seconds,
    status: r.status,
    deployer: r.deployer,
    host: r.host,
    notes: r.notes,
    failed_apps: r.failed_apps,
    // Pre-migration-0030 rows have no `variant`; treat absent as "prod".
    variant: r.variant || "prod",
  })));
}));

// Delete a deployment record (for cleaning up stray entries).
dataRoutes.delete("/deployments/:id", handler(async (c) => {
  const denied = requireRole(c, "infra");
  if (denied) return denied;
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  await pb.collection("deployments").delete(id);
  return c.json({ deleted: true });
}));

// =============================================================================
// Monitor — pod / cluster events
// =============================================================================

// Upsert a k8s Event by uid. Called continuously by the event-watcher service.
// Same uid is sent multiple times as count grows; we update last_seen + count
// rather than inserting duplicates.
dataRoutes.post("/pod_events", handler(async (c) => {
  const denied = requireRole(c, "infra");
  if (denied) return denied;
  const pb = c.get("pb");
  const body = await c.req.json<{
    uid: string;
    namespace?: string;
    involved_kind?: string;
    involved_name?: string;
    type: "Normal" | "Warning";
    reason?: string;
    message?: string;
    source?: string;
    count?: number;
    first_seen?: string;
    last_seen?: string;
  }>();

  if (!body.uid || !body.type) {
    return c.json({ error: "uid and type required" }, 400);
  }
  if (!["Normal", "Warning"].includes(body.type)) {
    return c.json({ error: "invalid type" }, 400);
  }

  const data = {
    uid: body.uid,
    namespace: body.namespace ?? "",
    involved_kind: body.involved_kind ?? "",
    involved_name: body.involved_name ?? "",
    type: body.type,
    reason: body.reason ?? "",
    message: body.message ?? "",
    source: body.source ?? "",
    count: body.count ?? 1,
    first_seen: body.first_seen ?? new Date().toISOString(),
    last_seen: body.last_seen ?? new Date().toISOString(),
  };

  try {
    const existing = await pb.collection("pod_events").getFirstListItem(
      pb.filter("uid = {:uid}", { uid: body.uid }),
    );
    const updated = await pb.collection("pod_events").update(existing.id, {
      count: data.count,
      last_seen: data.last_seen,
      message: data.message,
    });
    return c.json({ id: updated.id, action: "updated" });
  } catch {
    const created = await pb.collection("pod_events").create(data);
    return c.json({ id: created.id, action: "created" }, 201);
  }
}));

// List recent events. Filters: type (Normal|Warning), namespace, since (ISO).
dataRoutes.get("/pod_events", handler(async (c) => {
  const pb = c.get("pb");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);
  const type = c.req.query("type");
  const ns = c.req.query("namespace");
  const since = c.req.query("since");
  const before = c.req.query("before");
  const involvedName = c.req.query("involved_name");

  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (type) { clauses.push("type = {:type}"); params.type = type; }
  if (ns) { clauses.push("namespace = {:ns}"); params.ns = ns; }
  if (since) { clauses.push("last_seen >= {:since}"); params.since = since; }
  if (before) { clauses.push("last_seen <= {:before}"); params.before = before; }
  if (involvedName) { clauses.push("involved_name ~ {:involved_name}"); params.involved_name = involvedName; }
  const filter = clauses.length ? pb.filter(clauses.join(" && "), params) : "";

  const records = await pb.collection("pod_events").getList(1, limit, {
    sort: "-last_seen",
    filter,
  });
  return c.json(records.items.map((r) => ({
    id: r.id,
    uid: r.uid,
    namespace: r.namespace,
    involved_kind: r.involved_kind,
    involved_name: r.involved_name,
    type: r.type,
    reason: r.reason,
    message: r.message,
    source: r.source,
    count: r.count,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  })));
}));

// Delete pod_events older than `before` (ISO timestamp). Used for retention.
dataRoutes.delete("/pod_events", handler(async (c) => {
  const denied = requireRole(c, "infra");
  if (denied) return denied;
  const pb = c.get("pb");
  const before = c.req.query("before");
  if (!before) return c.json({ error: "before query param required" }, 400);

  const stale = await pb.collection("pod_events").getFullList({
    filter: pb.filter("last_seen < {:before}", { before }),
  });
  for (const r of stale) {
    await pb.collection("pod_events").delete(r.id);
  }
  return c.json({ deleted: stale.length });
}));
