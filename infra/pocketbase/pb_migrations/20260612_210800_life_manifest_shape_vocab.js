/// <reference path="../pb_data/types.d.ts" />

/*
 * Life vocabulary registry: rewrite every `life_logs.manifest` from the
 * field-schema trackable model to the shape/vocab-row model.
 *
 * OLD row: { id, label, group?, hidden?, fields: TypedField[], pinned? }
 * NEW row: { id, label, shape: "took"|"did"|"happened"|"rated", group?,
 *            defaultUnit?, defaultAmount?, defaultDuration?, ratingLabel?,
 *            hidden?, pinned? }
 *
 * Events are NOT touched — `id` stays the subject_id join key, and readers
 * are name-agnostic over historical entry names (dose/volume/drinks/...).
 *
 * Transform rules (classified on the non-text, non-category fields):
 *   - category + duration(min) field  → EXPLODE: one vocab row per category
 *     option (id = slugified option), shape "did", group = old trackable id,
 *     defaultDuration inherited; a companion rating field (e.g. exercise
 *     "intensity") becomes ratingLabel on each exploded row. The ORIGINAL row
 *     is KEPT but hidden:true (its events get rewritten to per-thing ids by a
 *     separate later script — this migration never touches events).
 *   - single rating field             → "rated"
 *   - single bool field               → "happened"
 *   - number field, unit "min"        → "did" (id "sleep" additionally gets
 *                                       ratingLabel:"quality")
 *   - number field, unit "ct"/none with defaultValue 1 (or none) → "happened"
 *   - any other number field          → "took" (defaultUnit = unit,
 *                                       defaultAmount = defaultValue)
 *   - anything else (text-only, no fields) → "happened" fallback
 *   - `hidden` and `pinned` preserved as-is; `group` preserved on
 *     non-exploded rows (it is now a semantic rollup, not a layout group)
 *   - special: `sleep_quality` additionally becomes hidden:true (its history
 *     will be merged into sleep events by a separate later script)
 *
 * Idempotent: a trackable that already has a `shape` (and no `fields`) is
 * passed through untouched, so re-running never double-explodes.
 *
 * Backup policy: this rewrites user data — run a `pre-migration-*` backup
 * before applying in prod (kept forever per infra/k8s/cronjobs.yaml).
 *
 * down() is a documented no-op: the field schemas are not recoverable from
 * the vocab rows (restore the pre-migration backup instead).
 *
 * Helpers are inlined (no require) — PB v0.25's migration JSVM has no
 * filesystem resolver (see 20260601_191856_life_manifest_column.js). The
 * transform is covered by vm-execution tests in
 * packages/backend/src/pocketbase-hooks/life-manifest-shape-migration.test.ts
 * which load THIS file and run the exported-via-global transform directly.
 */

// Inlined unwrapPbJson (mirrors lib/pb-json.js; require unavailable here).
function unwrapPbJson(raw) {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }
  if (Array.isArray(raw)) {
    var s = "";
    for (var i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
    try { return JSON.parse(s); } catch (_) { return {}; }
  }
  return {};
}

// Mirrors slugifyTrackableId in packages/backend/src/life-manifest-ops.ts —
// the in-app "create new thing" path and this explosion rule must mint
// identical ids ("PT" → "pt", "trip planning" → "trip-planning").
function slugifyTrackableId(label) {
  return String(label)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
}

/** Copy hidden/pinned (and optionally group) from an old row onto a new one. */
function carryCommon(oldT, row) {
  if (oldT.hidden) row.hidden = true;
  if (Array.isArray(oldT.pinned) && oldT.pinned.length > 0) row.pinned = oldT.pinned;
  return row;
}

/**
 * Transform ONE old-model trackable into its new-model vocab row(s).
 * Already-new rows pass through untouched (idempotency). `takenIds` is the
 * live set of ids in the output manifest, used to collision-guard exploded
 * ids (fallback `<oldId>-<slug>`; skip if even that is taken).
 */
function transformTrackable(t, takenIds) {
  // Already new-model (has shape, no field schema) → pass through.
  if (typeof t.shape === "string" && !Array.isArray(t.fields)) return [t];

  var fields = Array.isArray(t.fields) ? t.fields : [];
  var category = null;
  var duration = null;
  var rating = null;
  var primary = null; // first non-text, non-category field
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (!f || typeof f !== "object") continue;
    if (f.type === "category" && !category) category = f;
    else if (f.type === "number" && f.unit === "min" && !duration) duration = f;
    if (f.type === "rating" && !rating) rating = f;
    if (!primary && f.type !== "category" && f.type !== "text") primary = f;
  }

  // --- EXPLODE: category + duration -----------------------------------
  if (category && duration) {
    var out = [];
    // Keep the original row, hidden, as a did-shaped husk: its historical
    // events still aggregate until the later event-rewrite script splits
    // them onto the per-thing ids.
    var kept = { id: t.id, label: t.label, shape: "did" };
    if (typeof t.group === "string") kept.group = t.group;
    if (typeof duration.defaultValue === "number") kept.defaultDuration = duration.defaultValue;
    if (rating) kept.ratingLabel = rating.key;
    if (Array.isArray(t.pinned) && t.pinned.length > 0) kept.pinned = t.pinned;
    kept.hidden = true;
    out.push(kept);
    takenIds[t.id] = true;

    var options = Array.isArray(category.options) ? category.options : [];
    for (var j = 0; j < options.length; j++) {
      var opt = options[j];
      var slug = slugifyTrackableId(opt);
      if (!slug) continue;
      if (takenIds[slug]) slug = slugifyTrackableId(t.id + "-" + opt);
      if (!slug || takenIds[slug]) {
        console.log("  life_logs: skipping exploded option '" + opt + "' of '" + t.id + "' (id collision)");
        continue;
      }
      var row = { id: slug, label: opt, shape: "did", group: t.id };
      if (typeof duration.defaultValue === "number") row.defaultDuration = duration.defaultValue;
      if (rating) row.ratingLabel = rating.key;
      takenIds[slug] = true;
      out.push(row);
    }
    return out;
  }

  // --- Single-thing rows ------------------------------------------------
  var row2 = { id: t.id, label: t.label };
  if (typeof t.group === "string") row2.group = t.group;
  carryCommon(t, row2);
  takenIds[t.id] = true;

  if (!primary) {
    row2.shape = "happened"; // text-only / empty fields fallback
  } else if (primary.type === "rating") {
    row2.shape = "rated";
  } else if (primary.type === "bool") {
    row2.shape = "happened";
  } else if (primary.type === "number" && primary.unit === "min") {
    row2.shape = "did";
    if (typeof primary.defaultValue === "number") row2.defaultDuration = primary.defaultValue;
    if (t.id === "sleep") row2.ratingLabel = "quality";
  } else if (
    primary.type === "number" &&
    (primary.unit === "ct" || primary.unit === undefined || primary.unit === null) &&
    (primary.defaultValue === undefined || primary.defaultValue === null || primary.defaultValue === 1)
  ) {
    row2.shape = "happened";
  } else if (primary.type === "number") {
    row2.shape = "took";
    if (typeof primary.unit === "string" && primary.unit) row2.defaultUnit = primary.unit;
    if (typeof primary.defaultValue === "number") row2.defaultAmount = primary.defaultValue;
  } else {
    row2.shape = "happened";
  }

  // sleep_quality's history will be merged into sleep events by a later
  // script; hide it so the dashboard stops offering it as a separate thing.
  if (t.id === "sleep_quality") row2.hidden = true;

  return [row2];
}

/** Transform a whole manifest. Pure; returns null when nothing to do. */
function transformManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.trackables) || manifest.trackables.length === 0) {
    return null;
  }
  var alreadyNew = manifest.trackables.every(function (t) {
    return t && typeof t.shape === "string" && !Array.isArray(t.fields);
  });
  if (alreadyNew) return null;

  var takenIds = {};
  for (var i = 0; i < manifest.trackables.length; i++) {
    var t = manifest.trackables[i];
    if (t && typeof t.id === "string") takenIds[t.id] = true;
  }
  var next = [];
  for (var k = 0; k < manifest.trackables.length; k++) {
    var rows = transformTrackable(manifest.trackables[k], takenIds);
    for (var m = 0; m < rows.length; m++) next.push(rows[m]);
  }
  return { trackables: next };
}

// Expose the pure transform for the vm-execution tests (harmless in goja —
// just a property on the migration module's global object).
if (typeof globalThis === "object") {
  globalThis.__lifeManifestShapeTransform = { transformManifest: transformManifest, transformTrackable: transformTrackable, slugifyTrackableId: slugifyTrackableId };
}

migrate(
  (app) => {
    const rows = app.findRecordsByFilter("life_logs", "1=1");
    let rewritten = 0;
    let skipped = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const manifest = unwrapPbJson(r.get("manifest"));
      const next = transformManifest(manifest);
      if (!next) {
        skipped++;
        continue;
      }
      r.set("manifest", next);
      app.save(r);
      rewritten++;
    }
    console.log(
      "  life_logs: shape-vocab manifest rewrite on " +
        rewritten +
        " row(s), skipped " +
        skipped +
        " (empty or already new-model)",
    );
  },
  (app) => {
    // Irreversible data transform: the old field schemas are not recoverable
    // from vocab rows. Restore the pre-migration backup to roll back.
    console.log("  [down] life_logs: shape-vocab rewrite is irreversible; restore a pre-migration backup instead");
  },
);
