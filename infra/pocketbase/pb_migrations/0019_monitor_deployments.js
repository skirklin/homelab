/// <reference path="../pb_data/types.d.ts" />

/**
 * Deployment history collection for the monitor app.
 *
 * deploy.sh POSTs a row here after each run via /fn/data/deployments
 * (admin-pb write, no public access).
 */

migrate(
  (app) => {
    try {
      app.findCollectionByNameOrId("deployments");
      console.log("  deployments: already exists, skipping");
      return;
    } catch {
      // create below
    }

    const col = new Collection({
      type: "base",
      name: "deployments",
      // No public access — writes/reads go through the api service (admin pb)
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "text", name: "git_sha", required: true, max: 64 },
        { type: "text", name: "git_branch", max: 200 },
        { type: "text", name: "git_subject", max: 500 },
        { type: "json", name: "apps", maxSize: 5000 },
        { type: "number", name: "duration_seconds" },
        {
          type: "select",
          name: "status",
          values: ["success", "failure", "partial"],
          required: true,
        },
        { type: "text", name: "deployer", max: 200 },
        { type: "text", name: "host", max: 200 },
        { type: "text", name: "notes", max: 2000 },
        { type: "json", name: "failed_apps", maxSize: 2000 },
        {
          type: "autodate",
          name: "created",
          onCreate: true,
        },
        {
          type: "autodate",
          name: "updated",
          onCreate: true,
          onUpdate: true,
        },
      ],
      indexes: [
        "CREATE INDEX idx_deployments_created ON deployments (created DESC)",
        "CREATE INDEX idx_deployments_status ON deployments (status)",
      ],
    });

    app.save(col);
    console.log("  deployments: created");
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("deployments");
      app.delete(col);
    } catch {
      // already gone
    }
  }
);
