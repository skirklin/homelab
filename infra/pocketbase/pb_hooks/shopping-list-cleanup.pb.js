/// <reference path="../pb_data/types.d.ts" />

/**
 * shopping_lists delete cleanup — prevents dangling user.shopping_slugs refs.
 *
 * users.shopping_slugs is a JSON OBJECT mapping `{ slug: shopping_list_id }`
 * (not a multi-relation, not an array). PB does NOT cascade-clean it when a
 * shopping_lists record is deleted, so the next list deletion would leave a
 * dangling map entry that points at a non-existent list id. This hook scrubs
 * any keys whose value equals the deleted list's id, right after a successful
 * delete.
 *
 * Pure prevention: no current drift was observed in production at the time
 * this hook landed, so there is no companion prune script. The recipes hook
 * (recipe-box-cleanup.pb.js) had drift and ships with a one-shot prune; this
 * one doesn't need one — the next delete is the first delete that could
 * create drift, and this hook handles it.
 *
 * Note vs. recipe-box-cleanup: that hook scrubs a JSON ARRAY of ids. This
 * hook scrubs a JSON OBJECT and matches on the VALUE side of `{slug: id}`,
 * not on the key. Easy bug to write — re-read before tweaking.
 *
 * --------------------------------------------------------------------------
 * Goja sharp edges this file works around (mirrors recipe-box-cleanup.pb.js):
 *
 *   (a) JSON field "filter" — shopping_slugs is a JSON field, not a
 *       multi-relation, so the `?=` "any-equals" operator doesn't apply.
 *       We use `shopping_slugs ~ "<id>"` (substring on the JSON-encoded
 *       blob) to narrow the candidate set, then re-verify in JS. Record IDs
 *       are 15-char alnum so substring false positives are negligible, but
 *       JS re-checks anyway so we're correct either way.
 *
 *   (b) record.get on a JSON-object field can surface as a goja []byte
 *       (one number per UTF-8 byte of the stored JSON) instead of a parsed
 *       object — the 2026-05-22 incident class. We previously used
 *       `JSON.parse(JSON.stringify(raw))` and called it "bulletproof"; it
 *       was not (the round-trip preserves the byte-array shape, then
 *       Object.keys silently returns the numeric indices). We now inline
 *       an unwrap that handles all three shapes (object / string / byte
 *       array). See infra/pocketbase/pb_migrations/lib/pb-json.js.
 *
 *   (c) Module-scope helpers aren't reachable from inside the callback;
 *       inline the helper.
 *
 * Idempotency: if no key in the map points at the deleted id, the save is
 * skipped. Re-running on the same delete is a no-op.
 */
onRecordAfterDeleteSuccess((e) => {
  function toPlainObject(raw) {
    if (raw == null) return {};
    if (typeof raw === "object" && !Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch (_) { return {}; }
    }
    if (Array.isArray(raw)) {
      // goja []byte form: array of UTF-8 byte values. Decode.
      var s = "";
      for (var i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch (_) { /* fall through */ }
      return {};
    }
    return {};
  }

  const listId = e.record.id;
  if (!listId) {
    e.next();
    return;
  }

  let touched = 0;
  try {
    // Narrow with a substring filter on the JSON-encoded field; verify in JS.
    const candidates = $app.findRecordsByFilter(
      "users",
      "shopping_slugs ~ {:listId}",
      "",
      0,
      0,
      { listId: listId }
    );

    for (let i = 0; i < candidates.length; i++) {
      const user = candidates[i];
      const slugs = toPlainObject(user.get("shopping_slugs"));
      const keys = Object.keys(slugs);
      let changed = false;
      const pruned = {};
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (slugs[key] === listId) {
          changed = true;
          continue;
        }
        pruned[key] = slugs[key];
      }
      if (!changed) continue; // substring false positive — skip
      user.set("shopping_slugs", pruned);
      $app.save(user);
      touched++;
    }
  } catch (err) {
    // Don't let cleanup failures swallow the delete success. Log and move on.
    console.log("shopping-list-cleanup: error scrubbing refs for " + listId + ": " + (err && err.message ? err.message : err));
  }

  if (touched > 0) {
    console.log("shopping-list-cleanup: pruned " + listId + " from " + touched + " user(s)");
  }

  e.next();
}, "shopping_lists");
