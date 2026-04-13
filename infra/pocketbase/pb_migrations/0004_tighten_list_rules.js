/// <reference path="../pb_data/types.d.ts" />

/**
 * Tighten list/view rules on shopping_lists, task_lists, and life_logs.
 *
 * Previously: any authenticated user could list all records.
 * Now: only owners can list/view their own records.
 *
 * The join-list flow (where a non-owner needs to look up a list by ID)
 * is handled server-side via the API service's /sharing/list-info endpoint,
 * which uses an admin PB client to bypass these rules.
 */

migrate(
  (app) => {
    const ownerRule = '@request.auth.id != "" && @request.auth.id ?= owners.id';

    for (const name of ["shopping_lists", "task_lists", "life_logs"]) {
      const col = app.findCollectionByNameOrId(name);
      col.listRule = ownerRule;
      col.viewRule = ownerRule;
      app.save(col);
      console.log(`  ${name}: tightened list/view rules to owner-only`);
    }
  },
  (app) => {
    const openRule = '@request.auth.id != ""';

    for (const name of ["shopping_lists", "task_lists", "life_logs"]) {
      const col = app.findCollectionByNameOrId(name);
      col.listRule = openRule;
      col.viewRule = openRule;
      app.save(col);
      console.log(`  ${name}: reverted to open list/view rules`);
    }
  }
);
