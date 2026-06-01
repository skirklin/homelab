/// <reference path="../pb_data/types.d.ts" />

/*
 * P1 data model: re-introduce the `life_logs.manifest` JSON column and backfill
 * existing logs with a per-user, data-defined trackable manifest.
 *
 * Background
 * ----------
 * `life_logs.manifest` was dropped in 0032 (it was the Firebase-era widget
 * config, long stale). The life-app redesign (apps/life/ROADMAP.md, "multi-user
 * isolation + per-user data-defined trackables") brings it back with a NEW
 * meaning: `{ trackables: LifeManifestTrackable[] }` -- the generic, per-user
 * source of truth for what each user tracks. Sessions are NOT in here.
 *
 * What this migration does
 * ------------------------
 *   1. Adds the `manifest` json field (maxSize 100000, nullable) via the
 *      `col.fields.add(new Field({...}))` idiom.
 *   2. Backfills every existing log whose manifest is null/empty with a 1:1
 *      translation of the app's hardcoded TRACKABLES -- ids preserved, and each
 *      trackable's PRIMARY field keyed to the HISTORICAL entry name
 *      (`primaryEntryName`) so pre-migration `life_events` keep aggregating
 *      after the app's `primaryEntryName` switch is deleted in P2.
 *
 * New logs created AFTER this migration are NOT backfilled here; the backend's
 * getOrCreateLog seeds them with the minimal type-demo starter set on create.
 *
 * Idempotent: re-running skips the field add if present and skips any log that
 * already has a non-empty manifest, so it never clobbers a user's edits.
 *
 * Backup policy: this rewrites user data -- run a `pre-migration-*` backup
 * before applying in prod (kept forever per infra/k8s/cronjobs.yaml retention).
 *
 * down() drops the field again (mirrors 0032's up()).
 *
 * ---------------------------------------------------------------------------
 * WHY EVERYTHING IS INLINED (no require)
 * ---------------------------------------------------------------------------
 * PB v0.25's migration JSVM uses goja_nodejs/require with no filesystem
 * resolver -- `require("./lib/...")` panics with "Invalid module" (see
 * 0026_authz_strings_source_of_truth.js for the same finding). So both the
 * `unwrapPbJson` helper and the backfill payload are inlined below.
 *
 * The BACKFILL_MANIFEST block between the GENERATED markers is produced from
 * the canonical TS backfill (apps/life/app/src/lib/manifest-backfill.ts) by
 * apps/life/app/scripts/gen-backfill-manifest.ts. A vitest drift-check
 * (apps/life/app/src/lib/manifest-backfill.test.ts) parses this exact block
 * and asserts it equals `backfillManifest()`, so it can never silently drift.
 * DO NOT hand-edit between the markers -- re-run the generator.
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

/* BEGIN GENERATED MANIFEST -- do not hand-edit; run gen-backfill-manifest.ts */
const BACKFILL_MANIFEST = {
  "trackables": [
    {
      "id": "vyvanse",
      "label": "Vyvanse",
      "fields": [
        {
          "key": "dose",
          "type": "number",
          "unit": "mg",
          "defaultValue": 30
        }
      ],
      "group": "medical"
    },
    {
      "id": "vitamins",
      "label": "Vitamins",
      "fields": [
        {
          "key": "count",
          "type": "number",
          "unit": "ct",
          "defaultValue": 1
        }
      ],
      "group": "medical",
      "hidden": true
    },
    {
      "id": "ibuprofin",
      "label": "Ibuprofin",
      "fields": [
        {
          "key": "dose",
          "type": "number",
          "unit": "mg",
          "defaultValue": 400
        }
      ],
      "group": "medical",
      "hidden": true
    },
    {
      "id": "edibles",
      "label": "Edibles",
      "fields": [
        {
          "key": "dose",
          "type": "number",
          "unit": "mg",
          "defaultValue": 5
        }
      ],
      "group": "consumables",
      "pinned": [
        {
          "label": "2.5mg",
          "entries": [
            {
              "name": "dose",
              "type": "number",
              "value": 2.5,
              "unit": "mg"
            }
          ]
        },
        {
          "label": "5mg",
          "entries": [
            {
              "name": "dose",
              "type": "number",
              "value": 5,
              "unit": "mg"
            }
          ]
        },
        {
          "label": "10mg",
          "entries": [
            {
              "name": "dose",
              "type": "number",
              "value": 10,
              "unit": "mg"
            }
          ]
        }
      ]
    },
    {
      "id": "alcohol",
      "label": "Alcohol",
      "fields": [
        {
          "key": "drinks",
          "type": "number",
          "unit": "drinks",
          "defaultValue": 1
        }
      ],
      "group": "consumables"
    },
    {
      "id": "coffee",
      "label": "Coffee",
      "fields": [
        {
          "key": "volume",
          "type": "number",
          "unit": "oz",
          "defaultValue": 8
        }
      ],
      "group": "consumables"
    },
    {
      "id": "poop",
      "label": "Poop",
      "fields": [
        {
          "key": "count",
          "type": "number",
          "unit": "ct",
          "defaultValue": 1
        }
      ],
      "group": "bio"
    },
    {
      "id": "wank",
      "label": "Wank",
      "fields": [
        {
          "key": "count",
          "type": "number",
          "unit": "ct",
          "defaultValue": 1
        }
      ],
      "group": "bio"
    },
    {
      "id": "sex",
      "label": "Boink",
      "fields": [
        {
          "key": "count",
          "type": "number",
          "unit": "ct",
          "defaultValue": 1
        }
      ],
      "group": "bio"
    },
    {
      "id": "floss",
      "label": "Floss",
      "fields": [
        {
          "key": "count",
          "type": "number",
          "unit": "ct",
          "defaultValue": 1
        }
      ]
    },
    {
      "id": "sleep",
      "label": "Sleep",
      "fields": [
        {
          "key": "duration",
          "type": "number",
          "unit": "min",
          "defaultValue": 480
        },
        {
          "key": "notes",
          "type": "text",
          "optional": true
        }
      ],
      "group": "time-based",
      "pinned": [
        {
          "label": "7h",
          "entries": [
            {
              "name": "duration",
              "type": "number",
              "value": 420,
              "unit": "min"
            }
          ]
        },
        {
          "label": "8h",
          "entries": [
            {
              "name": "duration",
              "type": "number",
              "value": 480,
              "unit": "min"
            }
          ]
        },
        {
          "label": "9h",
          "entries": [
            {
              "name": "duration",
              "type": "number",
              "value": 540,
              "unit": "min"
            }
          ]
        }
      ]
    },
    {
      "id": "sleep_quality",
      "label": "Sleep quality",
      "fields": [
        {
          "key": "rating",
          "type": "rating",
          "scale": 5
        }
      ],
      "group": "time-based"
    },
    {
      "id": "exercise",
      "label": "Exercise",
      "fields": [
        {
          "key": "duration",
          "type": "number",
          "unit": "min",
          "defaultValue": 30
        },
        {
          "key": "category",
          "type": "category",
          "options": [
            "walk",
            "run",
            "bike",
            "PT",
            "lift",
            "yoga",
            "other"
          ]
        },
        {
          "key": "intensity",
          "type": "rating",
          "scale": 5,
          "optional": true
        }
      ],
      "group": "time-based"
    },
    {
      "id": "focus",
      "label": "Focus",
      "fields": [
        {
          "key": "duration",
          "type": "number",
          "unit": "min",
          "defaultValue": 25
        },
        {
          "key": "category",
          "type": "category",
          "options": [
            "chinese",
            "coding",
            "learning",
            "trip planning"
          ]
        }
      ],
      "group": "time-based"
    },
    {
      "id": "mood",
      "label": "Mood",
      "fields": [
        {
          "key": "rating",
          "type": "rating",
          "scale": 5
        }
      ],
      "group": "ratings",
      "hidden": true
    },
    {
      "id": "content",
      "label": "Content",
      "fields": [
        {
          "key": "rating",
          "type": "rating",
          "scale": 5
        }
      ],
      "group": "ratings",
      "hidden": true
    }
  ]
};
/* END GENERATED MANIFEST */

function manifestIsEmpty(raw) {
  // unwrapPbJson returns {} for null/garbage; a real manifest has a non-empty
  // trackables array.
  const m = unwrapPbJson(raw);
  return !m || !Array.isArray(m.trackables) || m.trackables.length === 0;
}

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");

    if (!col.fields.getByName("manifest")) {
      col.fields.add(
        new Field({
          type: "json",
          name: "manifest",
          maxSize: 100000,
        }),
      );
      app.save(col);
      console.log("  life_logs: added manifest field (json, maxSize 100000)");
    } else {
      console.log("  life_logs: manifest field already present, skipping add");
    }

    const rows = app.findRecordsByFilter("life_logs", "1=1");
    let backfilled = 0;
    let skipped = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!manifestIsEmpty(r.get("manifest"))) {
        skipped++;
        continue;
      }
      r.set("manifest", BACKFILL_MANIFEST);
      app.save(r);
      backfilled++;
    }
    console.log(
      "  life_logs: backfilled manifest on " +
        backfilled +
        " row(s), skipped " +
        skipped +
        " (already populated)",
    );
  },
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    const f = col.fields.getByName("manifest");
    if (f) {
      col.fields.removeById(f.id);
      app.save(col);
      console.log("  [down] life_logs: dropped manifest field");
    } else {
      console.log("  [down] life_logs: manifest field already absent, skipping");
    }
  },
);
