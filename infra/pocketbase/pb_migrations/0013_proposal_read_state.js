/// <reference path="../pb_data/types.d.ts" />

/**
 * Add read-state timestamps to trip_proposals so Claude can tell which
 * proposals have new user feedback since its last view.
 *
 * - user_responded_at: bumped by the UI whenever the user saves feedback,
 *   toggles a pick/vote, adds a per-candidate note, or resolves.
 * - claude_last_seen_at: bumped by the API when Claude fetches a proposal
 *   via get_trip_proposal or when it appears in a list_trip_proposals
 *   result.
 *
 * A proposal is "unread by Claude" when user_responded_at is set and either
 * claude_last_seen_at is null or user_responded_at > claude_last_seen_at.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("trip_proposals");
    for (const name of ["user_responded_at", "claude_last_seen_at"]) {
      if (!col.fields.getByName(name)) {
        col.fields.add(new Field({ type: "date", name }));
      }
    }
    app.save(col);
    console.log("  trip_proposals: added user_responded_at, claude_last_seen_at");
  },
  (app) => {
    const col = app.findCollectionByNameOrId("trip_proposals");
    for (const name of ["user_responded_at", "claude_last_seen_at"]) {
      const f = col.fields.getByName(name);
      if (f) col.fields.removeById(f.id);
    }
    app.save(col);
  }
);
