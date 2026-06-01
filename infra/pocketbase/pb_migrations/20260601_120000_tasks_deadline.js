/// <reference path="../pb_data/types.d.ts" />

/*
 * One-shot todos get an optional deadline (+ per-task lead time in days),
 * wired into the daily task-notification cron and the life morning review.
 *
 * Adds to `tasks`:
 *   - deadline           (date,   optional) — full ISO datetime tolerated; UI uses date granularity
 *   - deadline_lead_days (number, optional) — remind this many days before the deadline
 * Adds to `users`:
 *   - last_deadline_notification (date) — idempotency stamp, SEPARATE from last_task_notification
 *
 * The DB columns are universal (no constraint); only one-shot UI + logic read them.
 */

migrate(
  (app) => {
    const tasks = app.findCollectionByNameOrId("tasks");
    if (!tasks.fields.getByName("deadline")) {
      tasks.fields.add(new Field({ type: "date", name: "deadline" }));
    }
    if (!tasks.fields.getByName("deadline_lead_days")) {
      tasks.fields.add(new Field({ type: "number", name: "deadline_lead_days" }));
    }
    app.save(tasks);

    const users = app.findCollectionByNameOrId("users");
    if (!users.fields.getByName("last_deadline_notification")) {
      users.fields.add(new Field({ type: "date", name: "last_deadline_notification" }));
    }
    app.save(users);
  },
  (app) => {
    const tasks = app.findCollectionByNameOrId("tasks");
    for (const name of ["deadline", "deadline_lead_days"]) {
      const f = tasks.fields.getByName(name);
      if (f) tasks.fields.removeById(f.id);
    }
    app.save(tasks);

    const users = app.findCollectionByNameOrId("users");
    const f = users.fields.getByName("last_deadline_notification");
    if (f) users.fields.removeById(f.id);
    app.save(users);
  },
);
