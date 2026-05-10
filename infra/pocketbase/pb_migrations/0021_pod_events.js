/// <reference path="../pb_data/types.d.ts" />

/**
 * Pod / cluster events captured by the in-cluster event-watcher service.
 *
 * k8s only retains Events for ~1 hour by default; the watcher streams them
 * here for long-term history. `uid` is the k8s Event uid — the same logical
 * event can fire multiple times (count goes up, last_seen updates), so the
 * api upserts on uid match instead of inserting duplicates.
 */

migrate(
  (app) => {
    try {
      app.findCollectionByNameOrId("pod_events");
      console.log("  pod_events: already exists, skipping");
      return;
    } catch {
      // create below
    }

    const col = new Collection({
      type: "base",
      name: "pod_events",
      // No public access — read/write through the api service (admin pb).
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "text", name: "uid", required: true, max: 64 },
        { type: "text", name: "namespace", max: 200 },
        { type: "text", name: "involved_kind", max: 100 },
        { type: "text", name: "involved_name", max: 300 },
        {
          type: "select",
          name: "type",
          values: ["Normal", "Warning"],
          required: true,
        },
        { type: "text", name: "reason", max: 200 },
        { type: "text", name: "message", max: 4000 },
        { type: "text", name: "source", max: 200 },
        { type: "number", name: "count" },
        { type: "date", name: "first_seen" },
        { type: "date", name: "last_seen" },
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
        "CREATE UNIQUE INDEX idx_pod_events_uid ON pod_events (uid)",
        "CREATE INDEX idx_pod_events_last_seen ON pod_events (last_seen DESC)",
        "CREATE INDEX idx_pod_events_type ON pod_events (type)",
        "CREATE INDEX idx_pod_events_ns_obj ON pod_events (namespace, involved_name)",
      ],
    });

    app.save(col);
    console.log("  pod_events: created");
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("pod_events");
      app.delete(col);
    } catch {
      // already gone
    }
  }
);
