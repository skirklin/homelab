/// <reference path="../pb_data/types.d.ts" />

/**
 * Drop the vestigial `life_logs.manifest` JSON column.
 *
 * Background
 * ----------
 * `life_logs.manifest` was the original Firebase-era home for the life
 * tracker's widget + random-sample config. It was written from the life app
 * frontend whenever the user edited widgets in the (now-deleted) UI editor.
 *
 * Weeks ago, the life app moved its manifest to code (apps/life/.../manifest.ts)
 * and stopped writing to the column. The api-service push-notification
 * scheduler kept reading `logDoc.manifest.randomSamples` for prompt labels —
 * which meant pushes were labeled with whatever stale snapshot was last
 * persisted before the refactor.
 *
 * The api scheduler now reads `RANDOM_SAMPLES` from `@homelab/backend`
 * directly (the same constant the life UI uses), so the column has no
 * remaining readers or writers. Drop it.
 *
 * down() restores the column with its original 0001 shape (`json`, maxSize
 * 200000). No backfill — rolling back to a state that read this column is
 * rolling back to a known-broken state, and any prior content was stale
 * anyway. The structural restoration is enough.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    const f = col.fields.getByName("manifest");
    if (f) {
      col.fields.removeById(f.id);
      app.save(col);
      console.log("  life_logs: dropped manifest field");
    } else {
      console.log("  life_logs: manifest field already absent, skipping drop");
    }
  },
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    if (!col.fields.getByName("manifest")) {
      col.fields.add(
        new Field({
          type: "json",
          name: "manifest",
          maxSize: 200000,
        }),
      );
      app.save(col);
      console.log("  [down] life_logs: re-added manifest field (json, maxSize 200000)");
    } else {
      console.log("  [down] life_logs: manifest field already present, skipping add");
    }
  },
);
