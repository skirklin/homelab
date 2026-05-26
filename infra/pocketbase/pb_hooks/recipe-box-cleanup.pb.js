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
 *   (b) record.get on a JSON-array field can surface as a goja-wrapped
 *       Go slice (push appends 0, not the supplied value) OR as a JS
 *       array of UTF-8 byte values (one number per byte of the stored
 *       JSON, NOT the decoded elements). Naïve slice.call on the
 *       byte-array form returns the bytes themselves; push-ing onto
 *       that and saving corrupts the column into a mix of bytes + the
 *       appended value (see scott's recipe_boxes incident, 2026-05-26).
 *       toJsArray below detects all three shapes (real array, JSON
 *       string, byte-array) and always returns a fresh JS array of
 *       decoded elements safe to mutate. Mirrors lib/pb-json.js but
 *       for array-shaped JSON columns (vs object-shaped).
 *
 *   (c) Module-scope helpers aren't reachable from inside the callback;
 *       inline the helper. (See sharing.pb.js header for the full story.)
 *
 * Idempotency: if the array doesn't contain the id, the save is skipped.
 * Re-running on the same delete is a no-op.
 */
onRecordAfterDeleteSuccess((e) => {
  // Three goja shapes for a JSON-array column (mirrors sharing.pb.js
  // and lib/pb-json.js): real JS array, JSON string, byte-array. The
  // byte-array form looks like an Array but contains UTF-8 byte values
  // (one number per byte of the stored JSON), and a naïve slice.call
  // on it returns the bytes themselves — push/filter then corrupts the
  // column. Decode bytes back via String.fromCharCode + JSON.parse.
  // See scott's recipe_boxes corruption incident, 2026-05-26.
  function toJsArray(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      if (raw.length === 0) return [];
      if (typeof raw[0] !== "number") {
        return Array.prototype.slice.call(raw);
      }
      var s = "";
      for (var i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
      try {
        var parsed = JSON.parse(s);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) { return []; }
    }
    if (typeof raw === "string") {
      try {
        var parsedStr = JSON.parse(raw);
        return Array.isArray(parsedStr) ? parsedStr : [];
      } catch (_) { return []; }
    }
    return [];
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
