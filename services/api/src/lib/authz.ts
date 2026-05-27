/**
 * Authorization helpers. Per docs/auth-policy.md §5.1, all userOwns* /
 * userCan* / requireRole helpers live here so:
 *   - Other route modules can reach them by a short, stable import path.
 *   - The most security-sensitive code in the repo lives in a file whose
 *     name advertises that fact.
 *   - Tests can target the helpers directly without spinning up Hono.
 *
 * These helpers mirror the PB collection rules in
 * `infra/pocketbase/pb_migrations/lib/authz-rules.js` (`PB_RULES`,
 * re-exported below). The two paths must enforce the same invariants —
 * see §5.3 of the policy and the property test
 * `services/api/src/e2e/authz-mirror.test.ts`.
 */
import type { Context } from "hono";
import type PocketBase from "pocketbase";
import type { AppEnv } from "../index";

// Re-export the rule-string source of truth so callers in the TS world
// can import everything authz-related from a single module.
export {
  PB_RULES,
  OWNER_RULE,
  BOX_VIS_RULE,
  RECIPE_VIS_RULE,
  RECIPE_WRITE_RULE,
} from "../../../../infra/pocketbase/pb_migrations/lib/authz-rules.js";
export type {
  CollectionRules,
  UserOwnedCollection,
} from "../../../../infra/pocketbase/pb_migrations/lib/authz-rules.js";

// =============================================================================
// Tenancy helpers — return boolean ("ok"/"denied") or a typed result.
// Mirror the corresponding PB rule strings in PB_RULES.
// =============================================================================

/**
 * Verify `userId` is in `travel_logs[logId].owners`. Returns `false` if the
 * log doesn't exist OR the user isn't an owner. Use to gate every write
 * route on the travel surface — admin-PB bypasses collection rules, so
 * route-level enforcement is the only thing standing between an `hlk_`
 * token holder and cross-tenant writes into another user's log.
 *
 * Mirrors `PB_RULES.travel_logs.updateRule` / parent-of childRule("log").
 */
export async function userOwnsTravelLog(
  pb: PocketBase,
  logId: string,
  userId: string,
): Promise<boolean> {
  if (!logId || !userId) return false;
  try {
    const log = await pb.collection("travel_logs").getOne(logId);
    const owners = log.owners;
    return Array.isArray(owners) && owners.includes(userId);
  } catch {
    return false;
  }
}

/**
 * Verify `userId` is in `recipe_boxes[boxId].owners`. Returns `false` if the
 * box doesn't exist OR the user isn't an owner. Mirrors `userOwnsTravelLog`
 * — admin-PB bypasses PB's tightened (0024) rules so the route layer is the
 * only ownership gate for `hlk_`/`mcpat_` callers writing into another
 * user's box, recipes, or cooking log.
 *
 * Mirrors `PB_RULES.recipe_boxes.updateRule`.
 */
export async function userOwnsRecipeBox(
  pb: PocketBase,
  boxId: string,
  userId: string,
): Promise<boolean> {
  if (!boxId || !userId) return false;
  try {
    const box = await pb.collection("recipe_boxes").getOne(boxId);
    const owners = box.owners;
    return Array.isArray(owners) && owners.includes(userId);
  } catch {
    return false;
  }
}

/**
 * Authorization for recipe-level writes: caller must be in `recipe.owners`
 * OR in `box.owners`. Mirrors `PB_RULES.recipes.updateRule` (also
 * `deleteRule`). Returns `"notfound"` (recipe is missing) so the caller can
 * reply 404 separately from 403.
 */
export async function userCanWriteRecipe(
  pb: PocketBase,
  recipeId: string,
  userId: string,
): Promise<"ok" | "denied" | "notfound"> {
  if (!recipeId || !userId) return "denied";
  let recipe;
  try {
    recipe = await pb.collection("recipes").getOne(recipeId);
  } catch {
    return "notfound";
  }
  const recipeOwners = recipe.owners;
  if (Array.isArray(recipeOwners) && recipeOwners.includes(userId)) return "ok";
  if (await userOwnsRecipeBox(pb, recipe.box as string, userId)) return "ok";
  return "denied";
}

/**
 * Verify `userId` is in `task_lists[listId].owners`. Returns `false` if the
 * list doesn't exist OR the user isn't an owner. Mirrors `userOwnsTravelLog`
 * — admin-PB bypasses PB collection rules, so the route layer is the only
 * ownership gate for `hlk_`/`mcpat_` callers writing into another user's
 * task list or its child tasks/events.
 *
 * Mirrors `PB_RULES.task_lists.updateRule`.
 */
export async function userOwnsTaskList(
  pb: PocketBase,
  listId: string,
  userId: string,
): Promise<boolean> {
  if (!listId || !userId) return false;
  try {
    const list = await pb.collection("task_lists").getOne(listId);
    const owners = list.owners;
    return Array.isArray(owners) && owners.includes(userId);
  } catch {
    return false;
  }
}

/**
 * Verify `life_logs[logId].owner === userId`. Returns `false` if the log
 * doesn't exist OR the user is not the owner. Mirrors `userOwnsTravelLog`
 * — admin-PB bypasses PB collection rules, so the route layer is the only
 * ownership gate for `hlk_`/`mcpat_` callers writing into another user's
 * life log or its child entries.
 *
 * life_logs is single-owner (migration 0028). Mirrors
 * `PB_RULES.life_logs.updateRule` (`owner = @request.auth.id`).
 */
export async function userOwnsLifeLog(
  pb: PocketBase,
  logId: string,
  userId: string,
): Promise<boolean> {
  if (!logId || !userId) return false;
  try {
    const log = await pb.collection("life_logs").getOne(logId);
    return log.owner === userId;
  } catch {
    return false;
  }
}

/**
 * Verify `userId` is in `shopping_lists[listId].owners`. Returns `false` if
 * the list doesn't exist OR the user isn't an owner. Mirrors the PB rule
 * `@request.auth.id ?= owners.id` on shopping_lists (migration 0001).
 *
 * `hlk_`/`mcpat_` tokens authenticate against a superuser PB client
 * (services/api/src/middleware/auth.ts); that client ignores PB collection
 * rules entirely, so the route layer is the only ownership gate on this
 * surface for write paths that hit shopping_lists or list-scoped child
 * collections (shopping_items, shopping_trips).
 *
 * Mirrors `PB_RULES.shopping_lists.updateRule`.
 */
export async function userOwnsShoppingList(
  pb: PocketBase,
  listId: string,
  userId: string,
): Promise<boolean> {
  if (!listId || !userId) return false;
  try {
    const list = await pb.collection("shopping_lists").getOne(listId);
    const owners = list.owners;
    return Array.isArray(owners) && owners.includes(userId);
  } catch {
    return false;
  }
}

/**
 * Authorization for recipe READS via the data routes (token surface only).
 * Mirrors PB's tightened visRule (migration 0024 / `PB_RULES.recipes.viewRule`):
 *   - visibility === "public" → always allowed
 *   - caller in recipe.owners → allowed
 *   - caller in box.owners → allowed
 *   - (authed AND visibility !== "private") → allowed
 * The `userId` will always be set on this surface (authMiddleware refuses
 * unauthed requests), so the authed-and-not-private clause effectively
 * means "unlisted is visible to anyone with a token." This matches the
 * PB rule. Returns `"notfound"` when the recipe doesn't exist so the
 * caller can hide the 404 vs 403 distinction.
 */
export async function userCanReadRecipe(
  pb: PocketBase,
  recipeId: string,
  userId: string,
): Promise<
  | { status: "ok"; recipe: Record<string, unknown> }
  | { status: "denied" | "notfound" }
> {
  if (!recipeId) return { status: "notfound" };
  let recipe;
  try {
    recipe = await pb.collection("recipes").getOne(recipeId);
  } catch {
    return { status: "notfound" };
  }
  const visibility = recipe.visibility;
  if (visibility === "public") {
    return { status: "ok", recipe: recipe as unknown as Record<string, unknown> };
  }
  const recipeOwners = recipe.owners;
  if (userId && Array.isArray(recipeOwners) && recipeOwners.includes(userId)) {
    return { status: "ok", recipe: recipe as unknown as Record<string, unknown> };
  }
  if (userId && (await userOwnsRecipeBox(pb, recipe.box as string, userId))) {
    return { status: "ok", recipe: recipe as unknown as Record<string, unknown> };
  }
  if (userId && visibility !== "private") {
    return { status: "ok", recipe: recipe as unknown as Record<string, unknown> };
  }
  return { status: "denied" };
}

// =============================================================================
// Privilege helpers — return null on success, Response on failure.
// =============================================================================

/**
 * Generic role gate. Returns a 403 Response if the caller's `tokenRoles`
 * context value does not include `role`; otherwise returns null and the
 * caller proceeds. Per docs/auth-policy.md §5.2.
 *
 * Generalization of the old `requireInfraRole(c)` helper — call as
 * `requireRole(c, "infra")` (or `"monitoring-read"`, future roles).
 *
 * `tokenRoles` is stamped by the auth middleware. For PB-user JWTs and
 * OAuth `mcpat_` tokens it is always `[]` so they never satisfy a role
 * gate — only `hlk_` tokens carrying an explicit role do.
 */
export function requireRole(c: Context<AppEnv>, role: string): Response | null {
  const roles = c.get("tokenRoles") ?? [];
  if (!roles.includes(role)) {
    return c.json({ error: `Forbidden: ${role} role required` }, 403);
  }
  return null;
}

// =============================================================================
// PATCH-body sanitizers.
// =============================================================================

/**
 * Strip parent-pointer fields from a PATCH body before forwarding to PB.
 * Used to block **reparent attacks** — a user PATCH-ing a row they own to
 * set its `list` / `log` / `box` field to a victim's id, thereby moving
 * the row into the victim's container (or vice versa).
 *
 * Per docs/auth-policy.md §5.4. Example:
 *
 *   const patch = stripParentPointers(await c.req.json(), "list");
 *   await pb.collection("shopping_items").update(id, patch);
 *
 * Returns a new object — does not mutate the input.
 */
export function stripParentPointers<T extends Record<string, unknown>>(
  body: T,
  ...fields: string[]
): T {
  const out: Record<string, unknown> = { ...body };
  for (const f of fields) {
    delete out[f];
  }
  return out as T;
}
