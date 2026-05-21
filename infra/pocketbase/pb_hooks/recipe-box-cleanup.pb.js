/// <reference path="../pb_data/types.d.ts" />

/**
 * recipe_boxes delete cleanup — prevents dangling user.recipe_boxes refs.
 *
 * users.recipe_boxes is a JSON array of box IDs (not a multi-relation), so
 * PB does NOT cascade-clean it when a recipe_boxes record is deleted. Each
 * dangling entry produces a 404 from the recipes app's per-box fetch on
 * every page load. This hook scrubs the deleted box's id from every user's
 * recipe_boxes array right after a successful delete.
 *
 * One-shot cleanup of pre-existing drift lives in
 * services/scripts/prune-dangling-recipe-boxes.ts.
 *
 * --------------------------------------------------------------------------
 * Goja sharp edges this file works around (mirrors sharing.pb.js notes):
 *
 *   (a) JSON field "filter" — users.recipe_boxes is a JSON field, not a
 *       multi-relation, so the `?=` "any-equals" operator doesn't apply.
 *       We use `recipe_boxes ~ "<id>"` (substring) to narrow the candidate
 *       set, then re-verify membership in JS. Record IDs are 15-char alnum
 *       so substring false positives are negligible, but JS re-checks
 *       anyway so we're correct either way.
 *
 *   (b) record.get on a never-set / Go-slice JSON field returns a goja-
 *       wrapped value whose .push appends 0 instead of the supplied value.
 *       Copy into a fresh JS array via Array.prototype.slice.call before
 *       mutating. (Reading via indexOf works fine — the breakage is push.)
 *       We don't push here, but we DO filter/assign, so we copy defensively.
 *
 *   (c) Module-scope helpers aren't reachable from inside the callback;
 *       inline the helper. (See sharing.pb.js header for the full story.)
 *
 * Idempotency: if the array doesn't contain the id, the save is skipped.
 * Re-running on the same delete is a no-op.
 */
onRecordAfterDeleteSuccess((e) => {
  function toJsArray(raw) {
    if (!raw) return [];
    try { return Array.prototype.slice.call(raw); }
    catch (_) { return []; }
  }

  const boxId = e.record.id;
  if (!boxId) {
    e.next();
    return;
  }

  let touched = 0;
  try {
    // Narrow with a substring filter on the JSON-encoded field; verify in JS.
    const candidates = $app.findRecordsByFilter(
      "users",
      "recipe_boxes ~ {:boxId}",
      "",
      0,
      0,
      { boxId: boxId }
    );

    for (let i = 0; i < candidates.length; i++) {
      const user = candidates[i];
      const boxes = toJsArray(user.get("recipe_boxes"));
      const idx = boxes.indexOf(boxId);
      if (idx === -1) continue; // substring false positive — skip
      const pruned = boxes.filter(function (b) { return b !== boxId; });
      user.set("recipe_boxes", pruned);
      $app.save(user);
      touched++;
    }
  } catch (err) {
    // Don't let cleanup failures swallow the delete success. Log and move on.
    console.log("recipe-box-cleanup: error scrubbing refs for " + boxId + ": " + (err && err.message ? err.message : err));
  }

  if (touched > 0) {
    console.log("recipe-box-cleanup: pruned " + boxId + " from " + touched + " user(s)");
  }

  e.next();
}, "recipe_boxes");
