/// <reference path="../pb_data/types.d.ts" />

/*
 * Retire the per-source notification idempotency stamp columns now that the
 * single `notification_log` ledger (migration 20260619_200000) owns the
 * "already sent this window?" question for every cron that fully migrated onto
 * `notifyOnce`:
 *
 *   - users.last_task_notification      (upkeep recurring chores)
 *   - users.last_deadline_notification  (one-shot deadline / asap)
 *   - users.travel_notif_state          (travel morning / evening)
 *
 * DEPLOY-DAY DUPLICATE NOTE
 * -------------------------
 * The ledger starts empty and these stamps are dropped, so on deploy day the
 * first run of each of these crons sees no ledger row for a user and may send
 * ONE duplicate notification (the stamp that would have suppressed it is gone).
 * This is the SAME blast radius the crons already tolerate — a single redundant
 * daily nag — and self-heals after that first post-deploy run writes the ledger
 * row. No backfill is attempted (mapping three different stamp shapes into the
 * ledger isn't worth one possible dup per daily source).
 *
 * NOT DROPPED here:
 *   - life_logs.reminder_state — the life fixed-reminder cron no longer reads or
 *     writes it (it uses the ledger now), BUT the column + its `id`-immutability
 *     docs are referenced across the life manifest/view machinery owned by a
 *     separate workstream. Leaving the column in place is harmless (the cron
 *     simply stops touching it) and avoids stepping on that surface. A later
 *     phase can drop it once that workstream confirms nothing depends on it.
 *   - life_logs.sample_schedule — the random sampler's `sentTimes` was NOT
 *     migrated onto the ledger (it carries computed per-day schedule state, not
 *     a plain idempotency stamp); it stays its own store.
 */

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    let changed = false;
    for (const name of ["last_task_notification", "last_deadline_notification", "travel_notif_state"]) {
      const f = users.fields.getByName(name);
      if (f) {
        users.fields.removeById(f.id);
        changed = true;
        console.log(`  users: dropped ${name}`);
      }
    }
    if (changed) app.save(users);
  },
  (app) => {
    // Recreate the dropped columns with their original shapes so a rollback
    // leaves the schema intact (the cron code paths that read them are gone, so
    // the values stay empty — that's fine: an empty stamp reads as "not sent").
    const users = app.findCollectionByNameOrId("users");
    if (!users.fields.getByName("last_task_notification")) {
      users.fields.add(new Field({ type: "date", name: "last_task_notification" }));
    }
    if (!users.fields.getByName("last_deadline_notification")) {
      users.fields.add(new Field({ type: "date", name: "last_deadline_notification" }));
    }
    if (!users.fields.getByName("travel_notif_state")) {
      users.fields.add(new Field({ type: "json", name: "travel_notif_state", maxSize: 50000 }));
    }
    app.save(users);
    console.log("  [down] users: restored notification stamp columns");
  },
);
