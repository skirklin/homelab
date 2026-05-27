/**
 * Single source of truth for PocketBase collection access-rule strings on
 * the user-owned (tenancy-gated) collections enumerated in §3.1 of
 * docs/auth-policy.md.
 *
 * Consumed by:
 *   - infra/pocketbase/pb_migrations/0026_authz_strings_source_of_truth.js
 *     (asserts current PB state matches; rewrites if drifted)
 *   - services/api/src/lib/authz.ts (re-exports PB_RULES so route-level
 *     TS helpers and PB rules stay mirrored, per policy §5.3)
 *
 * NOTE on layout: this file lives under pb_migrations/lib/ rather than
 * pb_migrations/ itself so PocketBase's migration loader (which matches
 * `NNNN_*.js` at the top level of pb_migrations/) does not try to run it
 * as a migration. The PB migration requires it relatively. The TS side
 * imports it via the repo-root-relative path.
 *
 * The file is CommonJS (`module.exports`) so goja (PB's JS runtime) can
 * require() it. The TS side uses esModuleInterop + named destructure.
 *
 * **DO NOT** edit a single rule string here without also confirming the
 * mirror TS helper in services/api/src/lib/authz.ts still encodes the
 * same predicate. The e2e test src/e2e/authz-mirror.test.ts will catch
 * drift but only after the fact — keep the two in sync at edit time.
 */

// Reusable predicate fragments.
var OWNER_RULE =
  '@request.auth.id != "" && @request.auth.id ?= owners.id';

function childRule(parentField) {
  return (
    '@request.auth.id != "" && @request.auth.id ?= ' +
    parentField +
    ".owners.id"
  );
}

// recipe_boxes list/view visibility — mirrors 0001.
var BOX_VIS_RULE = [
  'visibility = "public"',
  '(@request.auth.id != "" && @request.auth.id ?= owners.id)',
  '(@request.auth.id != "" && visibility != "private")',
].join(" || ");

// recipes list/view visibility — mirrors the tightened (0024) rule.
// PRIVATE recipes are no longer leaked via a non-private parent box.
var RECIPE_VIS_RULE = [
  'visibility = "public"',
  '(@request.auth.id != "" && @request.auth.id ?= owners.id)',
  '(@request.auth.id != "" && @request.auth.id ?= box.owners.id)',
  '(@request.auth.id != "" && visibility != "private")',
].join(" || ");

// recipes write rule — owner OR box-owner. From 0001 (unchanged by 0024).
var RECIPE_WRITE_RULE =
  '@request.auth.id != "" && (@request.auth.id ?= owners.id || @request.auth.id ?= box.owners.id)';

// life_logs is single-owner (migration 0028) — direct equality, no `?=`.
var LIFE_OWNER_RULE =
  '@request.auth.id != "" && owner = @request.auth.id';
var LIFE_CHILD_RULE =
  '@request.auth.id != "" && log.owner = @request.auth.id';

/**
 * The per-collection PB rule strings, in canonical truthful form. Order of
 * keys mirrors the layout of 0001 for readability; do not rely on key order
 * programmatically.
 *
 * Shape: { <collection>: { listRule, viewRule, createRule, updateRule, deleteRule } }
 *
 * Notes per collection:
 *   - shopping_lists / task_lists / life_logs: list/view tightened to
 *     owner-only by migration 0004. createRule is still "any authed" —
 *     creating a list for yourself is universally allowed; the
 *     server-side flow stamps you as the owner.
 *   - All child collections: createRule tightened by 0024 to require
 *     parent ownership. list/view/update/delete were already owner-only
 *     via childRules() in 0001.
 *   - recipe_boxes / recipes: vis logic is its own thing; see VIS rules.
 */
var PB_RULES = Object.freeze({
  // ===== Shopping =====
  shopping_lists: {
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    createRule: '@request.auth.id != ""',
    updateRule: OWNER_RULE,
    deleteRule: OWNER_RULE,
  },
  shopping_items: {
    listRule: childRule("list"),
    viewRule: childRule("list"),
    createRule: childRule("list"),
    updateRule: childRule("list"),
    deleteRule: childRule("list"),
  },
  // shopping_history retired May 2026 — suggestions now derive from
  // shopping_trips. The drop migration is
  // 20260527_153805_drop_shopping_history.js.
  shopping_trips: {
    listRule: childRule("list"),
    viewRule: childRule("list"),
    createRule: childRule("list"),
    updateRule: childRule("list"),
    deleteRule: childRule("list"),
  },

  // ===== Recipes =====
  recipe_boxes: {
    listRule: BOX_VIS_RULE,
    viewRule: BOX_VIS_RULE,
    createRule: '@request.auth.id != ""',
    updateRule: OWNER_RULE,
    deleteRule: OWNER_RULE,
  },
  recipes: {
    listRule: RECIPE_VIS_RULE,
    viewRule: RECIPE_VIS_RULE,
    createRule: childRule("box"),
    updateRule: RECIPE_WRITE_RULE,
    deleteRule: RECIPE_WRITE_RULE,
  },
  recipe_events: {
    listRule: childRule("box"),
    viewRule: childRule("box"),
    createRule: childRule("box"),
    updateRule: childRule("box"),
    deleteRule: childRule("box"),
  },

  // ===== Life =====
  //
  // life_logs collapsed to a single `owner` relation in migration 0028 —
  // life is solo-user only. Rules use direct equality (`owner =`), not the
  // `?=` "any-of" operator (which only applies to multi-relations).
  life_logs: {
    listRule: LIFE_OWNER_RULE,
    viewRule: LIFE_OWNER_RULE,
    createRule: '@request.auth.id != ""',
    updateRule: LIFE_OWNER_RULE,
    deleteRule: LIFE_OWNER_RULE,
  },
  life_events: {
    listRule: LIFE_CHILD_RULE,
    viewRule: LIFE_CHILD_RULE,
    createRule: LIFE_CHILD_RULE,
    updateRule: LIFE_CHILD_RULE,
    deleteRule: LIFE_CHILD_RULE,
  },
  // claude_observations is created by the API service on behalf of a user
  // (createRule = "any authed") and read/updated/deleted only by the owner.
  // Single-relation `owner` column, same shape as life_logs post-0028 —
  // direct equality, no `?=` (which is for multi-relations).
  claude_observations: {
    listRule: LIFE_OWNER_RULE,
    viewRule: LIFE_OWNER_RULE,
    createRule: '@request.auth.id != ""',
    updateRule: LIFE_OWNER_RULE,
    deleteRule: LIFE_OWNER_RULE,
  },

  // ===== Upkeep / Tasks =====
  task_lists: {
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    createRule: '@request.auth.id != ""',
    updateRule: OWNER_RULE,
    deleteRule: OWNER_RULE,
  },
  tasks: {
    listRule: childRule("list"),
    viewRule: childRule("list"),
    createRule: childRule("list"),
    updateRule: childRule("list"),
    deleteRule: childRule("list"),
  },
  task_events: {
    listRule: childRule("list"),
    viewRule: childRule("list"),
    createRule: childRule("list"),
    updateRule: childRule("list"),
    deleteRule: childRule("list"),
  },

  // ===== Travel =====
  travel_logs: {
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    createRule: '@request.auth.id != ""',
    updateRule: OWNER_RULE,
    deleteRule: OWNER_RULE,
  },
  travel_trips: {
    listRule: childRule("log"),
    viewRule: childRule("log"),
    createRule: childRule("log"),
    updateRule: childRule("log"),
    deleteRule: childRule("log"),
  },
  travel_activities: {
    listRule: childRule("log"),
    viewRule: childRule("log"),
    createRule: childRule("log"),
    updateRule: childRule("log"),
    deleteRule: childRule("log"),
  },
  travel_itineraries: {
    listRule: childRule("log"),
    viewRule: childRule("log"),
    createRule: childRule("log"),
    updateRule: childRule("log"),
    deleteRule: childRule("log"),
  },
});

// CommonJS export (goja / PB migration require()).
module.exports = {
  PB_RULES: PB_RULES,
  OWNER_RULE: OWNER_RULE,
  BOX_VIS_RULE: BOX_VIS_RULE,
  RECIPE_VIS_RULE: RECIPE_VIS_RULE,
  RECIPE_WRITE_RULE: RECIPE_WRITE_RULE,
  LIFE_OWNER_RULE: LIFE_OWNER_RULE,
  LIFE_CHILD_RULE: LIFE_CHILD_RULE,
};
