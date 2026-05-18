/// <reference path="../pb_data/types.d.ts" />

/**
 * Tighten access rules across api_tokens, child collections, and recipes.
 *
 * Three independent fixes bundled because they all live in PB rule strings:
 *
 *   (1) api_tokens.createRule now requires `user = @request.auth.id`.
 *       Previously any authed user could mint a token row with
 *       `{user: <victim>, token_hash: <attacker-known-hash>}` and then
 *       authenticate as the victim via the auth middleware that trusts
 *       record.user. Account-takeover via direct PB write.
 *
 *   (2) Child-collection createRules now require parent ownership.
 *       Previously `createRule: '@request.auth.id != ""'` let any authed
 *       user POST rows into another user's list/box/log. Affects
 *       shopping_items, shopping_history, shopping_trips, recipes,
 *       recipe_events, life_events, tasks, task_events, travel_trips,
 *       travel_activities, travel_itineraries.
 *
 *   (3) recipes.{listRule,viewRule} no longer leak private recipes via
 *       a non-private parent box. The old rule had clauses that matched
 *       on box.visibility alone, ignoring per-recipe visibility:
 *           'box.visibility = "public"'
 *           'box.visibility != "private"' (with auth)
 *       Both removed. A private recipe is now private regardless of
 *       which box it lives in. Recipe-owner / box-owner / public-recipe
 *       / authed-and-recipe-non-private clauses preserved.
 */

migrate(
  (app) => {
    // ---------- (1) api_tokens.createRule ----------
    {
      const col = app.findCollectionByNameOrId("api_tokens");
      col.createRule = '@request.auth.id != "" && user = @request.auth.id';
      app.save(col);
      console.log("  api_tokens: createRule tightened");
    }

    // ---------- (2) child-collection createRules ----------
    // Map of collection name -> parent field used by its existing
    // listRule/viewRule/updateRule/deleteRule. The createRule should
    // mirror those — only parent owners can create children.
    const childCollections = [
      ["shopping_items",     "list"],
      ["shopping_history",   "list"],
      ["shopping_trips",     "list"],
      ["recipe_events",      "box"],
      ["life_events",        "log"],
      ["tasks",              "list"],
      ["task_events",        "list"],
      ["travel_trips",       "log"],
      ["travel_activities",  "log"],
      ["travel_itineraries", "log"],
    ];
    for (const [name, parentField] of childCollections) {
      const col = app.findCollectionByNameOrId(name);
      col.createRule = `@request.auth.id != "" && @request.auth.id ?= ${parentField}.owners.id`;
      app.save(col);
      console.log(`  ${name}: createRule tightened to require ${parentField}.owners membership`);
    }

    // recipes is also a child of recipe_boxes, but it's special-cased in
    // 0001 (it has its own visibility logic). The createRule there was
    // just '@request.auth.id != ""'; tighten to require box ownership.
    {
      const col = app.findCollectionByNameOrId("recipes");
      col.createRule = '@request.auth.id != "" && @request.auth.id ?= box.owners.id';
      app.save(col);
      console.log("  recipes: createRule tightened to require box.owners membership");
    }

    // ---------- (3) recipes.{listRule,viewRule} ----------
    {
      const col = app.findCollectionByNameOrId("recipes");
      const visRule = [
        'visibility = "public"',
        '(@request.auth.id != "" && @request.auth.id ?= owners.id)',
        '(@request.auth.id != "" && @request.auth.id ?= box.owners.id)',
        '(@request.auth.id != "" && visibility != "private")',
      ].join(" || ");
      col.listRule = visRule;
      col.viewRule = visRule;
      app.save(col);
      console.log("  recipes: list/viewRule fixed (private-in-public-box leak closed)");
    }
  },
  (app) => {
    // ---------- (1) api_tokens revert ----------
    {
      const col = app.findCollectionByNameOrId("api_tokens");
      col.createRule = '@request.auth.id != ""';
      app.save(col);
    }

    // ---------- (2) child-collection revert ----------
    const childNames = [
      "shopping_items", "shopping_history", "shopping_trips",
      "recipe_events",
      "life_events",
      "tasks", "task_events",
      "travel_trips", "travel_activities", "travel_itineraries",
    ];
    for (const name of childNames) {
      const col = app.findCollectionByNameOrId(name);
      col.createRule = '@request.auth.id != ""';
      app.save(col);
    }
    {
      const col = app.findCollectionByNameOrId("recipes");
      col.createRule = '@request.auth.id != ""';
      app.save(col);
    }

    // ---------- (3) recipes vis revert ----------
    {
      const col = app.findCollectionByNameOrId("recipes");
      const visRule = [
        'visibility = "public"',
        'box.visibility = "public"',
        '(@request.auth.id != "" && @request.auth.id ?= owners.id)',
        '(@request.auth.id != "" && @request.auth.id ?= box.owners.id)',
        '(@request.auth.id != "" && box.visibility != "private")',
        '(@request.auth.id != "" && visibility != "private")',
      ].join(" || ");
      col.listRule = visRule;
      col.viewRule = visRule;
      app.save(col);
    }
  }
);
