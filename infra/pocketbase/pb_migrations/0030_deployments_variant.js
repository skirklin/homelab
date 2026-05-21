/// <reference path="../pb_data/types.d.ts" />

/**
 * Add a `variant` discriminator to the `deployments` collection so the
 * monitor frontend can show beta-channel deploys separately from prod.
 *
 * Background: `beta.kirkl.in` now serves a separately-tagged `home` image
 * (`home-beta` Deployment, image `home:beta`) deployed via
 * `./infra/deploy.sh --beta`. That command POSTs `variant: "beta"` to
 * /fn/data/deployments so the deploy history is partitionable; default
 * runs POST `variant: "prod"` to keep the back-fill story trivial
 * (existing rows with no variant render as prod).
 *
 * Constrained `select` rather than free-text `text` so anything other
 * than "prod" / "beta" is a 400 at PB write time, not a silent typo
 * that splits the dashboard into three buckets.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("deployments");
    if (!col.fields.getByName("variant")) {
      col.fields.add(new Field({
        type: "select",
        name: "variant",
        values: ["prod", "beta"],
        // Not required — pre-existing rows have no variant; treat absent as prod.
        required: false,
      }));
      app.save(col);
      console.log("  deployments: added variant");
    }
  },
  (app) => {
    const col = app.findCollectionByNameOrId("deployments");
    const f = col.fields.getByName("variant");
    if (f) {
      col.fields.removeById(f.id);
      app.save(col);
    }
  }
);
