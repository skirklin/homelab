/// <reference path="../pb_data/types.d.ts" />

/**
 * Add `thread_id` to `chat_messages` to separate the PM-iteration channel
 * from per-observation reply threads (and, going forward, any other
 * entity-scoped chat). The Coach SDK session is keyed by `(ownerId, threadId)`
 * after this migration so the two surfaces never share context.
 *
 * Scheme (no sentinels — every row gets an explicit thread id):
 *   - PM channel:                thread_id = "pm"
 *   - Per-observation thread:    thread_id = "obs:<observation_record_id>"
 *   - Future entity-scoped:      thread_id = "<kind>:<id>" (e.g. "trip:abc")
 *
 * Migration steps:
 *   1. Add `thread_id` text field, required, default "pm", min length 1.
 *   2. Backfill every existing row to thread_id="pm" (they're all PM-channel
 *      today — the only existing caller is /chat).
 *
 * Backfill uses a raw UPDATE via `app.db().newQuery(...)` (same pattern as
 * 0013_backfill_empty_timestamps.js). Raw UPDATE bypasses model validation,
 * which lets us stamp the new column on rows whose current state would
 * fail the new required-field rule.
 *
 * Idempotent (matches the convention of the original chat_messages migration
 * + every other migration written since `_TEMPLATE.js.example` landed).
 */

migrate(
  (app) => {
    let col;
    try {
      col = app.findCollectionByNameOrId("chat_messages");
    } catch {
      console.log("  chat_messages: collection not found, skipping thread_id add");
      return;
    }

    if (!col.fields.getByName("thread_id")) {
      // Required + min:1 enforces "no sentinel empty string." PB doesn't
      // surface a per-field default in the goja schema API the way the
      // admin UI does, so the contract is enforced at two layers:
      //   - the API layer defaults `thread_id` to "pm" if a caller forgets it
      //     (matches the brief's "new columns default to 'pm'")
      //   - the migration backfills every existing row to "pm" below
      // Combined, the column never sees an empty value either in steady
      // state or during the migration cutover.
      col.fields.add(
        new Field({
          type: "text",
          name: "thread_id",
          required: true,
          min: 1,
          max: 200,
        }),
      );
      app.save(col);
      console.log("  chat_messages: added thread_id field");
    } else {
      console.log("  chat_messages: thread_id already present, skipping field add");
    }

    // Backfill any rows missing thread_id. Raw UPDATE so we don't trip the
    // new required-field rule via the model path. Pattern matches
    // 0013_backfill_empty_timestamps.js.
    const res = app.db()
      .newQuery(
        "UPDATE {{chat_messages}} SET thread_id = 'pm' WHERE thread_id = '' OR thread_id IS NULL",
      )
      .execute();
    const n = res.rowsAffected ? res.rowsAffected() : "?";
    console.log(`  chat_messages: backfilled thread_id='pm' on ${n} row(s)`);
  },
  (app) => {
    let col;
    try {
      col = app.findCollectionByNameOrId("chat_messages");
    } catch {
      console.log("  chat_messages: collection not found, skipping thread_id drop");
      return;
    }
    const f = col.fields.getByName("thread_id");
    if (f) {
      col.fields.removeById(f.id);
      app.save(col);
      console.log("  chat_messages: dropped thread_id field");
    }
  },
);
