/// <reference path="../pb_data/types.d.ts" />

/**
 * Create the `coach_sessions` collection for the realtime Coach agent.
 *
 * Phase D1 (scaffolding) — see apps/life/OBSERVER_BUILD_PLAN.md
 * §"Phase D — Realtime Coach Agent (Claude Agent SDK harness)".
 *
 * This collection is the storage backing for a custom `SessionStore` adapter
 * (`services/coach/src/session-store.ts`) that mirrors the
 * `@anthropic-ai/claude-agent-sdk` session-transcript state to PocketBase so
 * the coach pod can restart at any time and resume the in-flight
 * conversation from PB.
 *
 * One row per `(owner, project_key, session_id, subpath)` tuple — matches
 * the SDK's `SessionKey` shape (`{projectKey, sessionId, subpath?}`). The
 * SDK's `append(key, entries[])` call appends batched transcript entries
 * under that key; `load(key)` returns the full entries array.
 *
 * Owner-scoped, single-owner shape (mirrors life_logs post-0028 /
 * claude_observations / chat_messages) using LIFE_OWNER_RULE form
 * `@request.auth.id != "" && owner = @request.auth.id` so the rule strings
 * line up with PB_RULES in `lib/authz-rules.js` and the drift test in
 * `services/api/src/e2e/authz-mirror.test.ts`. Direct equality on the
 * single-relation column — `?=` is the any-of operator and is for
 * multi-relations only.
 *
 * The coach service runs as a trusted backend and writes via admin-PB
 * (bypasses owner rules), so createRule could be loose. We keep it
 * owner-equality anyway: defense-in-depth in case the rules ever come into
 * play (e.g., a future surface that hands a session row back to the user
 * directly).
 *
 * Indexes:
 *   - UNIQUE (owner, project_key, session_id, subpath) — every SDK
 *     `append`/`load`/`delete` is keyed by this tuple; `subpath` is `""`
 *     for main transcripts (PB indexes don't accept NULL-aware uniqueness
 *     cleanly under sqlite, so we store empty string for "no subpath").
 *   - (owner, last_activity DESC) — future cleanup jobs can cheaply find
 *     stale sessions.
 *
 * Idempotent: re-running this migration is a no-op (matches the pattern
 * established by claude_observations / chat_messages).
 */

migrate(
  (app) => {
    try {
      app.findCollectionByNameOrId("coach_sessions");
      console.log("  coach_sessions: already exists, skipping");
      return;
    } catch {
      // Collection doesn't exist, create it
    }

    const usersCol = app.findCollectionByNameOrId("users");

    const OWNER_RULE = '@request.auth.id != "" && owner = @request.auth.id';

    const col = new Collection({
      type: "base",
      name: "coach_sessions",
      listRule: OWNER_RULE,
      viewRule: OWNER_RULE,
      createRule: OWNER_RULE,
      updateRule: OWNER_RULE,
      deleteRule: OWNER_RULE,
      fields: [
        {
          type: "relation",
          name: "owner",
          collectionId: usersCol.id,
          cascadeDelete: false,
          maxSelect: 1,
          required: true,
        },
        // SDK SessionKey.projectKey — caller-defined tenant scope. The
        // coach service uses a fixed "coach" project key today, but it's
        // stored explicitly so future surfaces (e.g. a per-trip coach
        // subagent) can partition without colliding.
        { type: "text", name: "project_key", required: true, max: 200 },
        // SDK SessionKey.sessionId — UUID the SDK assigns. Indexed via the
        // compound unique index below.
        { type: "text", name: "session_id", required: true, max: 100 },
        // SDK SessionKey.subpath — `""` for main transcripts, otherwise
        // e.g. `subagents/agent-<id>`. Stored as text (not nullable) so
        // the compound unique index works under sqlite.
        { type: "text", name: "subpath", required: false, max: 200 },
        // Array of SessionStoreEntry — opaque JSON blobs per the SDK
        // contract. Read TS-side via defensive coercion; in goja
        // migrations always via unwrapPbJson (see lib/pb-json.js). Cap
        // is generous (5 MB) — long agent conversations with tool-use
        // transcripts can run large.
        { type: "json", name: "entries", maxSize: 5242880 },
        // Touched on every append/load — used for future TTL cleanup.
        {
          type: "autodate",
          name: "last_activity",
          onCreate: true,
          onUpdate: true,
        },
        {
          type: "autodate",
          name: "created",
          onCreate: true,
          onUpdate: false,
        },
        {
          type: "autodate",
          name: "updated",
          onCreate: true,
          onUpdate: true,
        },
      ],
      indexes: [
        // Every SDK call (append/load/delete) is keyed by the full
        // (owner, projectKey, sessionId, subpath) tuple — unique compound
        // index makes it a single B-tree lookup and prevents duplicate
        // rows for the same session key.
        "CREATE UNIQUE INDEX idx_coach_sessions_owner_key ON coach_sessions (owner, project_key, session_id, subpath)",
        // Future cleanup ("drop sessions inactive > 90 days") needs a
        // cheap per-owner scan ordered by last_activity.
        "CREATE INDEX idx_coach_sessions_owner_activity ON coach_sessions (owner, last_activity DESC)",
      ],
    });

    app.save(col);
    console.log("  coach_sessions: created");
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("coach_sessions");
      app.delete(col);
      console.log("  coach_sessions: deleted");
    } catch {
      console.log("  coach_sessions: already absent, skipping delete");
    }
  },
);
