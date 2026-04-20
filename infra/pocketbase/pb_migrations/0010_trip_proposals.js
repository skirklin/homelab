/// <reference path="../pb_data/types.d.ts" />

/**
 * Add trip_proposals collection for Claude-driven travel planning.
 *
 * A proposal is a curated comparison of candidate activities with Claude's
 * reasoning and user feedback. See apps/travel docs for the UX.
 *
 * Per-candidate feedback is stored as a JSON map keyed by activity ID:
 *   { "<activityId>": { vote?: "up" | "down", picked?: bool, notes?: string } }
 */

migrate(
  (app) => {
    try {
      app.findCollectionByNameOrId("trip_proposals");
      console.log("  trip_proposals: already exists, skipping");
      return;
    } catch {
      // Create below
    }

    const trips = app.findCollectionByNameOrId("travel_trips");

    const col = new Collection({
      type: "base",
      name: "trip_proposals",
      // Proposals are visible to anyone who owns the parent trip's log
      listRule: '@request.auth.id != "" && @request.auth.id ?= trip.log.owners.id',
      viewRule: '@request.auth.id != "" && @request.auth.id ?= trip.log.owners.id',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != "" && @request.auth.id ?= trip.log.owners.id',
      deleteRule: '@request.auth.id != "" && @request.auth.id ?= trip.log.owners.id',
      fields: [
        {
          type: "relation",
          name: "trip",
          collectionId: trips.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        { type: "text", name: "question", required: true },
        { type: "text", name: "reasoning", max: 10000 },
        { type: "json", name: "candidate_ids", maxSize: 5000 },
        { type: "json", name: "claude_picks", maxSize: 5000 },
        { type: "json", name: "feedback", maxSize: 50000 },
        { type: "text", name: "overall_feedback", max: 10000 },
        { type: "select", name: "state", values: ["open", "resolved"], required: true },
        { type: "date", name: "resolved_at" },
      ],
      indexes: [
        "CREATE INDEX idx_proposals_trip ON trip_proposals (trip)",
        "CREATE INDEX idx_proposals_state ON trip_proposals (state)",
      ],
    });

    app.save(col);
    console.log("  trip_proposals: created");
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("trip_proposals");
      app.delete(col);
    } catch {
      // already gone
    }
  }
);
