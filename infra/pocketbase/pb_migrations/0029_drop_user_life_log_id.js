/// <reference path="../pb_data/types.d.ts" />

/**
 * Drop the redundant `users.life_log_id` forward pointer.
 *
 * Background
 * ----------
 * Migration 0028 collapsed life_logs to a single-owner shape (owner relation
 * back to users). With that back-pointer in place, the forward pointer that
 * 0001 stamped onto `users.life_log_id` is pure cache: every "get the user's
 * life log" call now has a one-row filter (`owner = {:uid}`) that is the
 * source of truth, and the dual-write on getOrCreateLog had a real failure
 * mode where a stale id orphaned the user's real data.
 *
 * This migration removes the column. The TS code in this commit
 * (packages/backend/src/pocketbase/life.ts) is updated in lockstep — once
 * 0029 lands, any code still reading life_log_id will get `undefined` and
 * fall through to the back-pointer lookup, but the cleaner shape is to
 * just stop asking for it.
 *
 * down() restores the field (single-relation to life_logs, optional) and
 * backfills from `life_logs.owner`. The field was originally a `text` column
 * in 0001 holding the log id, but a single-relation is the structurally
 * correct restoration — text was a Firebase-era artifact.
 */

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const f = users.fields.getByName("life_log_id");
    if (f) {
      users.fields.removeById(f.id);
      app.save(users);
      console.log("  users: dropped life_log_id field");
    } else {
      console.log("  users: life_log_id field already absent, skipping drop");
    }
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const logs = app.findCollectionByNameOrId("life_logs");

    if (!users.fields.getByName("life_log_id")) {
      users.fields.add(
        new Field({
          type: "relation",
          name: "life_log_id",
          collectionId: logs.id,
          maxSelect: 1,
          cascadeDelete: false,
          required: false,
        }),
      );
      app.save(users);
      console.log("  [down] users: re-added life_log_id (relation, single)");
    }

    // Backfill from the life_logs.owner back-pointer. Solo-user surface, so
    // at most one row per user.
    const rows = app.findAllRecords("life_logs");
    let backfilled = 0;
    for (let i = 0; i < rows.length; i++) {
      const log = rows[i];
      const ownerId = log.get("owner");
      if (!ownerId) continue;
      try {
        const u = app.findRecordById("users", ownerId);
        if (u.get("life_log_id") !== log.id) {
          u.set("life_log_id", log.id);
          app.save(u);
          backfilled += 1;
        }
      } catch (e) {
        // Owner user gone — leave the pointer unset.
        console.log("  [down] could not backfill for log " + log.id + ": " + e);
      }
    }
    console.log("  [down] users: backfilled life_log_id on " + backfilled + " row(s)");
  },
);
