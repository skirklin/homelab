/// <reference path="../pb_data/types.d.ts" />

/*
 * Rename tasks.notify_users → tasks.assignees.
 *
 * Phase A of the assignee feature (see TASK-MODEL-DESIGN.md). The old
 * `notify_users` multi-relation is retired and becomes `assignees`: the SOLE
 * notification driver. `created_by` stays as immutable provenance and remains
 * the cascade's terminal floor.
 *
 * This is a pure SCHEMA rename — it preserves the field's id + its multi-
 * relation config, so existing relation values carry over untouched (no row
 * rewrite, no JSON-column read → no unwrapPbJson needed). Every existing task
 * currently has an EMPTY notify_users (it was never populated), so the rename
 * loses no data. The `assignees = [created_by]` backfill is a SEPARATE one-shot
 * script (services/scripts/backfill-task-assignees.ts) so the operator can
 * dry-run it against prod before writing.
 *
 * Renaming the field (rather than add-new + drop-old) keeps the field id stable
 * so nothing that references it by id breaks, and is a no-op on row data.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("tasks");

    // Idempotent: only rename if the old name still exists and the new one
    // doesn't (so a re-run after a partial apply is safe).
    const old = col.fields.getByName("notify_users");
    const already = col.fields.getByName("assignees");
    if (old && !already) {
      old.name = "assignees";
      app.save(col);
      console.log("  tasks: renamed field notify_users → assignees");
    } else if (already) {
      console.log("  tasks: assignees already present — no-op");
    } else {
      console.log("  tasks: notify_users field not found — no-op");
    }
  },
  (app) => {
    // Down: rename back to notify_users.
    const col = app.findCollectionByNameOrId("tasks");
    const renamed = col.fields.getByName("assignees");
    const old = col.fields.getByName("notify_users");
    if (renamed && !old) {
      renamed.name = "notify_users";
      app.save(col);
      console.log("  tasks: reverted field assignees → notify_users");
    }
  },
);
