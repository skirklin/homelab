/// <reference path="../pb_data/types.d.ts" />

/**
 * Atomic task-tag updates — closes the cross-device race in tagTask.
 *
 * Background:
 *   The TS adapter (`packages/backend/src/pocketbase/upkeep.ts:tagTask`) and
 *   the API server route (`services/api/src/routes/data.ts /tasks/:id/tags`)
 *   both implemented "read tags → merge add/remove → write" client-side.
 *   On a single client the wpb queue made the read+write atomic relative
 *   to local pending mutations (Bundle 6's 2b96bc7). But two devices /
 *   tabs editing the same task at the same instant still race at the
 *   network level: each reads `tags = ["a"]`, locally computes its own
 *   merge, and PATCHes back its own result — last-write wins, the
 *   loser's add/remove is dropped.
 *
 *   This hook moves the read+merge+write inside a single SQL transaction
 *   via `$app.runInTransaction(...)`. Two simultaneous calls now serialize
 *   on SQLite's row lock; both adds land instead of one stomping the other.
 *
 * Endpoint:
 *   POST /api/tasks/{id}/tags
 *     body: { add?: string[], remove?: string[] }
 *     auth: user-token (PB JWT)
 *     200:  { task: { id, tags, ... } }
 *     401:  no auth
 *     400:  invalid body
 *     403:  caller is not an owner of the task's list
 *     404:  task / list not found
 *
 * Ownership:
 *   Matches `tasks.updateRule` from migration 0001:
 *     `@request.auth.id != "" && @request.auth.id ?= list.owners.id`
 *   The caller must be in `task_lists[task.list].owners`. Same shape as
 *   the API route's `userOwnsTaskList` check (services/api/src/lib/authz.ts).
 *
 *   Superuser callers (PB admin client) bypass the ownership check — the
 *   Hono API service in services/api proxies hlk_/mcpat_ token requests
 *   through admin-pb and does its own userOwnsTaskList() before hitting
 *   the hook. Routing those through here closes the same cross-device
 *   race for the admin path without duplicating the transactional
 *   merge-and-write logic. Discriminator pattern matches api_tokens.pb.js:
 *   `auth.collection().name === "_superusers"`.
 *
 * --------------------------------------------------------------------------
 * goja sharp edges this file works around (mirror sharing.pb.js notes):
 *
 *   (a) Module-scope helpers are NOT reachable inside a routerAdd callback —
 *       calls throw `<name> is not defined`. So `toJsArray` is inlined.
 *
 *   (b) JSON-array columns (here: `tasks.tags`) can surface from .get() as
 *       one of three shapes: real JS array, JSON string, or array of UTF-8
 *       byte values. Naive `Array.prototype.slice.call(raw)` on the byte
 *       shape returns the bytes themselves; pushing onto that and saving
 *       corrupts the column. Same incident class as scott's recipe_boxes
 *       on 2026-05-26. The inlined toJsArray below detects and decodes
 *       all three shapes — kept in sync with the helpers in
 *       sharing.pb.js / recipe-box-cleanup.pb.js (the test in
 *       packages/backend/src/pocketbase-hooks/to-js-array.test.ts
 *       round-trips the matrix across all three copies).
 */

routerAdd("POST", "/api/tasks/{id}/tags", (e) => {
  // Inlined helper — see header note (b). Returns a fresh JS array of
  // decoded tag strings regardless of which goja shape the column comes
  // back as. Safe to push/filter/JSON.stringify the result.
  function toJsArray(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      if (raw.length === 0) return [];
      if (typeof raw[0] !== "number") {
        // Real JS array — copy defensively.
        return Array.prototype.slice.call(raw);
      }
      // Byte-array shape — decode and re-parse.
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

  const auth = e.auth;
  if (!auth) {
    return e.json(401, { error: "Authentication required" });
  }

  // Identify superuser callers — those bypass the per-list ownership check.
  // Method form (`auth.collection().name`) because the property form
  // `auth.collectionName` is undefined under PB 0.25 goja (see api_tokens.pb.js).
  let isSuperuser = false;
  try {
    if (typeof auth.collection === "function") {
      const coll = auth.collection();
      if (coll && coll.name === "_superusers") isSuperuser = true;
    }
  } catch (_) {
    // Defensive — if we can't tell, treat as non-superuser (closed-fail).
    isSuperuser = false;
  }

  const id = e.request.pathValue("id");
  if (!id) {
    return e.json(400, { error: "Missing task id" });
  }

  let body;
  try {
    body = e.requestInfo().body || {};
  } catch (_) {
    body = {};
  }
  const add = Array.isArray(body.add) ? body.add : [];
  const remove = Array.isArray(body.remove) ? body.remove : [];
  if (add.length === 0 && remove.length === 0) {
    return e.json(400, { error: "at least one of add[] / remove[] required" });
  }

  // Pre-flight: load task + list outside the txn so we can return 404 / 403
  // cleanly. The authoritative read happens inside runInTransaction below;
  // this just lets us fail fast without opening a write txn.
  let preTask;
  try {
    preTask = $app.findRecordById("tasks", id);
  } catch (_) {
    return e.json(404, { error: "task not found" });
  }
  const listId = preTask.get("list");
  if (!listId) {
    return e.json(404, { error: "task has no list" });
  }
  let preList;
  try {
    preList = $app.findRecordById("task_lists", listId);
  } catch (_) {
    return e.json(404, { error: "list not found" });
  }
  // Match `tasks.updateRule` — auth.id must be in list.owners.
  // Owners on read is fine; only push-side goja mangles relations (header (b)).
  // Superuser bypass: the Hono API has already done userOwnsTaskList() before
  // proxying through admin-pb; no second authorization check needed.
  if (!isSuperuser) {
    const owners = preList.get("owners") || [];
    if (owners.indexOf(auth.id) === -1) {
      return e.json(403, { error: "must be an owner of the task's list" });
    }
  }

  // ---- Transactional read-merge-write ------------------------------------
  // Two concurrent callers serialize on the row lock that txApp.save takes
  // out on the tasks row. Both see the most-recent merged state and write
  // a strict superset; no add/remove is lost.
  let updated;
  try {
    $app.runInTransaction((txApp) => {
      const record = txApp.findRecordById("tasks", id);
      const current = toJsArray(record.get("tags"));
      const removeSet = {};
      for (let i = 0; i < remove.length; i++) removeSet[remove[i]] = true;

      // Filter, then append adds in order (deduped against the survivors).
      const merged = [];
      for (let i = 0; i < current.length; i++) {
        const t = current[i];
        if (!removeSet[t] && merged.indexOf(t) === -1) merged.push(t);
      }
      for (let i = 0; i < add.length; i++) {
        const t = add[i];
        if (merged.indexOf(t) === -1) merged.push(t);
      }

      record.set("tags", merged);
      txApp.save(record);
      updated = record;
    });
  } catch (err) {
    return e.json(500, { error: "tag update failed: " + (err && err.message ? err.message : String(err)) });
  }

  // Echo the post-image so the caller can settle its local state without
  // a separate getOne round-trip.
  return e.json(200, {
    task: {
      id: updated.id,
      tags: toJsArray(updated.get("tags")),
    },
  });
});
