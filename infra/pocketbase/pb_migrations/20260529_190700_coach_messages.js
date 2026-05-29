/// <reference path="../pb_data/types.d.ts" />

/**
 * Create the `coach_messages` collection for the PM ↔ user "Coach" channel.
 *
 * Chat-shaped, owner-scoped, append-only. The "assistant" is the daily PM
 * cron in v1; the chat-log model is chosen deliberately so a future realtime
 * Claude Code SDK responder can be an additive swap, not a rewrite.
 *
 * See apps/life/OBSERVER_BUILD_PLAN.md §"Phase C — PM ↔ user channel" for
 * the design rationale.
 *
 * Single-owner shape (mirrors life_logs post-0028 / claude_observations) —
 * uses the LIFE_OWNER_RULE form `@request.auth.id != "" && owner = @request.auth.id`
 * so the rule strings line up with the entries in `lib/authz-rules.js`
 * (PB_RULES) and the property test in `services/api/src/e2e/authz-mirror.test.ts`.
 * Direct equality on the single-relation column — `?=` is the any-of operator
 * and is for multi-relations only.
 *
 * Includes a `(owner, created DESC)` index from day one — every read filters
 * by owner and orders newest-first; the collection grows append-only and we
 * don't want to repeat the deferred-index pattern from claude_observations.
 *
 * Idempotent: re-running this migration is a no-op (matches the pattern
 * established by 0002_sharing_invites.js / 0010_trip_proposals.js /
 * 20260527_193312_claude_observations.js).
 */

migrate(
  (app) => {
    try {
      app.findCollectionByNameOrId("coach_messages");
      console.log("  coach_messages: already exists, skipping");
      return;
    } catch {
      // Collection doesn't exist, create it
    }

    const usersCol = app.findCollectionByNameOrId("users");

    const OWNER_RULE = '@request.auth.id != "" && owner = @request.auth.id';

    const col = new Collection({
      type: "base",
      name: "coach_messages",
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
        {
          type: "select",
          name: "role",
          values: ["assistant", "user"],
          required: true,
          maxSelect: 1,
        },
        // 20000 char cap = room for prose + a structured deploy-request
        // checklist + 1–2 UX questions. Not unbounded.
        { type: "text", name: "body", required: true, max: 20000 },
        {
          type: "select",
          name: "kind",
          values: ["chat", "question", "deploy_request", "feedback", "note"],
          required: true,
          maxSelect: 1,
        },
        { type: "bool", name: "resolved" },
        // Optional structured payload (e.g. deploy_request: { sha, files[] }).
        // Read TS-side via defensive coercion; in goja migrations always via
        // unwrapPbJson (see lib/pb-json.js).
        { type: "json", name: "meta", maxSize: 50000 },
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
        // Every read filters by owner and orders by created DESC. Compound
        // index makes that one B-tree lookup instead of two passes.
        "CREATE INDEX idx_coach_messages_owner_created ON coach_messages (owner, created DESC)",
      ],
    });

    app.save(col);
    console.log("  coach_messages: created");
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("coach_messages");
      app.delete(col);
      console.log("  coach_messages: deleted");
    } catch {
      console.log("  coach_messages: already absent, skipping delete");
    }
  },
);
