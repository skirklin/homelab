/// <reference path="../pb_data/types.d.ts" />

/**
 * Unified task system — add tree fields to tasks collection.
 *
 * Adds: parent_id, path (materialized), position, task_type, completed, tags, collapsed
 * Removes: room_id from tasks, room_defs from task_lists
 *
 * Backfills existing tasks as root-level recurring tasks.
 */

migrate(
  (app) => {
    // --- Add new fields to tasks ---
    const tasks = app.findCollectionByNameOrId("tasks");

    tasks.fields.add(new Field({ type: "text", name: "parent_id" }));
    tasks.fields.add(new Field({ type: "text", name: "path" }));
    tasks.fields.add(new Field({ type: "number", name: "position" }));
    tasks.fields.add(new Field({
      type: "select",
      name: "task_type",
      values: ["recurring", "one_shot"],
    }));
    tasks.fields.add(new Field({ type: "bool", name: "completed" }));
    tasks.fields.add(new Field({ type: "json", name: "tags", maxSize: 50000 }));
    tasks.fields.add(new Field({ type: "bool", name: "collapsed" }));

    // Remove room_id
    tasks.fields.removeById(tasks.fields.getByName("room_id")?.getId());

    app.save(tasks);
    console.log("  tasks: added tree fields, removed room_id");

    // --- Remove room_defs from task_lists ---
    const taskLists = app.findCollectionByNameOrId("task_lists");
    taskLists.fields.removeById(taskLists.fields.getByName("room_defs")?.getId());
    app.save(taskLists);
    console.log("  task_lists: removed room_defs");

    // --- Add index on path for subtree queries ---
    tasks.indexes = [
      ...(tasks.indexes || []),
      'CREATE INDEX idx_tasks_path ON tasks (path)',
      'CREATE INDEX idx_tasks_parent ON tasks (parent_id)',
    ];
    app.save(tasks);

    // --- Backfill existing tasks ---
    const allTasks = app.findRecordsByFilter("tasks", "1=1");
    for (let i = 0; i < allTasks.length; i++) {
      const t = allTasks[i];
      t.set("parent_id", "");
      t.set("path", t.getId());
      t.set("position", i + 1);
      t.set("task_type", "recurring");
      t.set("completed", false);
      t.set("tags", []);
      t.set("collapsed", false);
      app.save(t);
    }
    console.log(`  tasks: backfilled ${allTasks.length} existing tasks`);
  },
  (app) => {
    // Revert: remove new fields, restore room_id and room_defs
    const tasks = app.findCollectionByNameOrId("tasks");

    for (const name of ["parent_id", "path", "position", "task_type", "completed", "tags", "collapsed"]) {
      const field = tasks.fields.getByName(name);
      if (field) tasks.fields.removeById(field.getId());
    }

    tasks.fields.add(new Field({ type: "text", name: "room_id" }));
    app.save(tasks);

    const taskLists = app.findCollectionByNameOrId("task_lists");
    taskLists.fields.add(new Field({ type: "json", name: "room_defs", maxSize: 50000 }));
    app.save(taskLists);

    console.log("  tasks/task_lists: reverted unified task changes");
  }
);
