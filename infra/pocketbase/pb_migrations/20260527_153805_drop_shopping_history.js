/// <reference path="../pb_data/types.d.ts" />

/**
 * Drop the `shopping_history` collection.
 *
 * Background: `shopping_history` was retired from the app's read path in
 * commit 257402c (May 2026) — suggestions are now derived from
 * `shopping_trips` (each completed trip's `items` JSON blob is what the
 * AddItem autocomplete + category lookup walk over; see
 * apps/shopping/app/src/suggestions.ts). The collection has been orphan
 * data ever since: nothing reads or writes it. The trips-as-source flow
 * has been live and verified in production. We're dropping the empty
 * collection now.
 *
 * Notes:
 *   - The `lib/authz-rules.js` source-of-truth file is updated in the
 *     same change to remove `shopping_history` from `PB_RULES`. The
 *     already-applied 0026 migration's inlined PB_RULES still contains
 *     `shopping_history`, but 0026 only runs once and its loop already
 *     handles "collection not found; skipping" gracefully — so dropping
 *     the collection doesn't break re-running migrations on fresh PBs
 *     (where 0001 also won't create it again because this migration
 *     drops it in the same migrate-up sweep on first boot).
 *   - down() recreates the schema but NOT the data. Daily PB backups
 *     (`pb-backup-daily` CronJob) are the recovery path for the actual
 *     rows if a rollback ever turns out to need them.
 */

migrate(
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("shopping_history");
      app.delete(col);
      console.log("  shopping_history: dropped");
    } catch (e) {
      // Already gone (fresh PB where the collection was never created,
      // or a re-run on an already-migrated DB). Idempotent no-op.
      console.log("  shopping_history: not found, skipping");
    }
  },
  (app) => {
    // Recreate the schema (mirrors 0001's definition). Data is NOT
    // restored — restore from a `daily-*` backup if you actually need
    // the rows back.
    try {
      app.findCollectionByNameOrId("shopping_history");
      console.log("  shopping_history: already exists, skipping recreate");
      return;
    } catch (e) {
      // Not found — go ahead and recreate.
    }

    const shoppingLists = app.findCollectionByNameOrId("shopping_lists");
    const childRule =
      '@request.auth.id != "" && @request.auth.id ?= list.owners.id';

    const col = new Collection({
      type: "base",
      name: "shopping_history",
      listRule: childRule,
      viewRule: childRule,
      createRule: childRule,
      updateRule: childRule,
      deleteRule: childRule,
      fields: [
        {
          type: "relation",
          name: "list",
          collectionId: shoppingLists.id,
          cascadeDelete: true,
          maxSelect: 1,
          required: true,
        },
        { type: "text", name: "ingredient", required: true },
        { type: "text", name: "category_id" },
        { type: "date", name: "last_added" },
      ],
    });
    app.save(col);
    console.log("  shopping_history: schema recreated (rows NOT restored)");
  },
);
