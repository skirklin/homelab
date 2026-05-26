/// <reference path="../pb_data/types.d.ts" />

/**
 * Tasks: add `cleared` boolean (default false).
 *
 * "Clear done" in the outliner sets this flag on completed one_shot tasks
 * so they no longer render in the default view, without destroying the row
 * (a user can always re-flip it via update_task). Recurring tasks are
 * never cleared — they self-reset via last_completed.
 *
 * No backfill needed: the field defaults to false and that's the desired
 * value for every existing row.
 *
 * Access rules don't need touching — `cleared` is a leaf bool that rides
 * on the existing list/view rules (which already gate access by task_list
 * ownership).
 */

migrate(
  (app) => {
    const tasks = app.findCollectionByNameOrId("tasks");
    if (!tasks.fields.getByName("cleared")) {
      tasks.fields.add(new Field({ type: "bool", name: "cleared" }));
      app.save(tasks);
      console.log("  tasks: added cleared bool field");
    } else {
      console.log("  tasks: cleared field already present, skipping");
    }
  },
  (app) => {
    const tasks = app.findCollectionByNameOrId("tasks");
    const f = tasks.fields.getByName("cleared");
    if (f) {
      tasks.fields.removeById(f.id);
      app.save(tasks);
    }
  },
);
