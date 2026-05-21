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
 *   (b) record.get on a JSON-object field returns a goja-wrapped object
 *       whose mutations don't always stick. Copy into a fresh plain JS
 *       object before mutating. We use JSON.parse(JSON.stringify(raw)) —
 *       slower than a shallow clone but bulletproof for these tiny maps,
 *       and matches the recipe-box hook's "copy defensively" stance.
 *
 *   (c) Module-scope helpers aren't reachable from inside the callback;
 *       inline the helper.
 *
 * Idempotency: if no key in the map points at the deleted id, the save is
 * skipped. Re-running on the same delete is a no-op.
 */
onRecordAfterDeleteSuccess((e) => {
  function toPlainObject(raw) {
    if (!raw) return {};
    try {
      const copy = JSON.parse(JSON.stringify(raw));
      if (copy && typeof copy === "object" && !Array.isArray(copy)) return copy;
      return {};
    } catch (_) {
      return {};
    }
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
