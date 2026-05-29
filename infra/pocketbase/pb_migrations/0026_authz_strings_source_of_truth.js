/// <reference path="../pb_data/types.d.ts" />

/**
 * Establish the single source of truth for PocketBase access-rule strings
 * on every user-owned (tenancy-gated) collection — per
 * docs/auth-policy.md §5.3 ("PB rules and API route gates should mirror
 * each other").
 *
 * **Authoritative file**: `infra/pocketbase/pb_migrations/lib/authz-rules.js`.
 * That file is consumed by:
 *   - services/api/src/lib/authz.ts → re-exports `PB_RULES` so the
 *     TS route helpers and the PB rules can be cross-validated.
 *   - services/api/src/e2e/authz-mirror.test.ts → property test that
 *     asserts (a) `PB_RULES` matches the rule strings the live PB has
 *     stamped on each collection, and (b) the TS helper for each
 *     collection agrees with the PB rule's allow/deny decision.
 *
 * **Why the rules are inlined here instead of `require()`d**: PB v0.25's
 * migration JSVM uses goja_nodejs/require with no filesystem resolver
 * — only explicitly registered native modules can be required. There's
 * no equivalent of `__hooks` for migrations, and `require("./lib/...")`
 * panics with "Invalid module". The TS-side authz-mirror test catches
 * any drift between this file's inlined rules, `lib/authz-rules.js`,
 * and the live PB schema, so single-source-of-truth is enforced by the
 * test rather than by import.
 *
 * Idempotent: for each (collection, rule) pair, if PB already matches
 * the canonical rule we do nothing; otherwise we log the diff and
 * overwrite. down() is a no-op — this migration only re-anchors, it
 * doesn't establish anything new (0001 + 0004 + 0024 already set these
 * rules; 0026 is a consistency check).
 */

// Helpers — kept identical to lib/authz-rules.js. The test asserts
// equality between this object and the shared file at boot.
const OWNER_RULE = '@request.auth.id != "" && @request.auth.id ?= owners.id';
function childRule(parentField) {
  return (
    '@request.auth.id != "" && @request.auth.id ?= ' +
    parentField +
    ".owners.id"
  );
}
const BOX_VIS_RULE = [
  'visibility = "public"',
  '(@request.auth.id != "" && @request.auth.id ?= owners.id)',
  '(@request.auth.id != "" && visibility != "private")',
].join(" || ");
const RECIPE_VIS_RULE = [
  'visibility = "public"',
  '(@request.auth.id != "" && @request.auth.id ?= owners.id)',
  '(@request.auth.id != "" && @request.auth.id ?= box.owners.id)',
  '(@request.auth.id != "" && visibility != "private")',
].join(" || ");
const RECIPE_WRITE_RULE =
  '@request.auth.id != "" && (@request.auth.id ?= owners.id || @request.auth.id ?= box.owners.id)';

const PB_RULES = {
  // ===== Shopping =====
  shopping_lists: {
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    createRule: '@request.auth.id != ""',
    updateRule: OWNER_RULE,
    deleteRule: OWNER_RULE,
  },
  shopping_items: {
    listRule: childRule("list"),
    viewRule: childRule("list"),
    createRule: childRule("list"),
    updateRule: childRule("list"),
    deleteRule: childRule("list"),
  },
  shopping_history: {
    listRule: childRule("list"),
    viewRule: childRule("list"),
    createRule: childRule("list"),
    updateRule: childRule("list"),
    deleteRule: childRule("list"),
  },
  shopping_trips: {
    listRule: childRule("list"),
    viewRule: childRule("list"),
    createRule: childRule("list"),
    updateRule: childRule("list"),
    deleteRule: childRule("list"),
  },

  // ===== Recipes =====
  recipe_boxes: {
    listRule: BOX_VIS_RULE,
    viewRule: BOX_VIS_RULE,
    createRule: '@request.auth.id != ""',
    updateRule: OWNER_RULE,
    deleteRule: OWNER_RULE,
  },
  recipes: {
    listRule: RECIPE_VIS_RULE,
    viewRule: RECIPE_VIS_RULE,
    createRule: childRule("box"),
    updateRule: RECIPE_WRITE_RULE,
    deleteRule: RECIPE_WRITE_RULE,
  },
  recipe_events: {
    listRule: childRule("box"),
    viewRule: childRule("box"),
    createRule: childRule("box"),
    updateRule: childRule("box"),
    deleteRule: childRule("box"),
  },

  // ===== Life =====
  life_logs: {
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    createRule: '@request.auth.id != ""',
    updateRule: OWNER_RULE,
    deleteRule: OWNER_RULE,
  },
  life_events: {
    listRule: childRule("log"),
    viewRule: childRule("log"),
    createRule: childRule("log"),
    updateRule: childRule("log"),
    deleteRule: childRule("log"),
  },
  // claude_observations — single-owner shape matching life_logs post-0028.
  // Kept character-identical to lib/authz-rules.js (the drift test pins this).
  claude_observations: {
    listRule: '@request.auth.id != "" && owner = @request.auth.id',
    viewRule: '@request.auth.id != "" && owner = @request.auth.id',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != "" && owner = @request.auth.id',
    deleteRule: '@request.auth.id != "" && owner = @request.auth.id',
  },
  // chat_messages — single-owner Chat channel (Phase C; renamed from
  // "coach_messages" pre-deploy. See apps/life/OBSERVER_BUILD_PLAN.md.) Kept
  // character-identical to lib/authz-rules.js (the drift test pins this).
  chat_messages: {
    listRule: '@request.auth.id != "" && owner = @request.auth.id',
    viewRule: '@request.auth.id != "" && owner = @request.auth.id',
    createRule: '@request.auth.id != "" && owner = @request.auth.id',
    updateRule: '@request.auth.id != "" && owner = @request.auth.id',
    deleteRule: '@request.auth.id != "" && owner = @request.auth.id',
  },

  // ===== Upkeep / Tasks =====
  task_lists: {
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    createRule: '@request.auth.id != ""',
    updateRule: OWNER_RULE,
    deleteRule: OWNER_RULE,
  },
  tasks: {
    listRule: childRule("list"),
    viewRule: childRule("list"),
    createRule: childRule("list"),
    updateRule: childRule("list"),
    deleteRule: childRule("list"),
  },
  task_events: {
    listRule: childRule("list"),
    viewRule: childRule("list"),
    createRule: childRule("list"),
    updateRule: childRule("list"),
    deleteRule: childRule("list"),
  },

  // ===== Travel =====
  travel_logs: {
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    createRule: '@request.auth.id != ""',
    updateRule: OWNER_RULE,
    deleteRule: OWNER_RULE,
  },
  travel_trips: {
    listRule: childRule("log"),
    viewRule: childRule("log"),
    createRule: childRule("log"),
    updateRule: childRule("log"),
    deleteRule: childRule("log"),
  },
  travel_activities: {
    listRule: childRule("log"),
    viewRule: childRule("log"),
    createRule: childRule("log"),
    updateRule: childRule("log"),
    deleteRule: childRule("log"),
  },
  travel_itineraries: {
    listRule: childRule("log"),
    viewRule: childRule("log"),
    createRule: childRule("log"),
    updateRule: childRule("log"),
    deleteRule: childRule("log"),
  },
};

const RULE_FIELDS = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"];

migrate(
  (app) => {
    let mismatches = 0;
    let collections = 0;
    const names = Object.keys(PB_RULES);

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const want = PB_RULES[name];
      let col;
      try {
        col = app.findCollectionByNameOrId(name);
      } catch (e) {
        console.log(
          "  [authz-strings] WARN collection " +
            name +
            " not found; skipping (was it dropped?)"
        );
        continue;
      }
      collections += 1;

      let dirty = false;
      for (let j = 0; j < RULE_FIELDS.length; j++) {
        const field = RULE_FIELDS[j];
        // `col[field]` may be a Go *string (nullable) wrapped by goja.
        // Coerce explicitly so `!==` compares values, not handle identity.
        const raw = col[field];
        const have = raw == null ? null : String(raw);
        const wantStr = want[field];
        if (have !== wantStr) {
          mismatches += 1;
          console.log(
            "  [authz-strings] DRIFT " +
              name +
              "." +
              field +
              "\n      have: " +
              (have == null ? "<null>" : JSON.stringify(have)) +
              "\n      want: " +
              JSON.stringify(wantStr)
          );
          col[field] = wantStr;
          dirty = true;
        }
      }
      if (dirty) {
        app.save(col);
        console.log("  [authz-strings] " + name + ": rules re-anchored");
      }
    }

    if (mismatches === 0) {
      console.log(
        "  [authz-strings] OK: " +
          collections +
          " collections in PB_RULES already match"
      );
    } else {
      console.log(
        "  [authz-strings] DONE: " +
          mismatches +
          " mismatch(es) corrected across " +
          collections +
          " collections"
      );
    }
  },
  (app) => {
    // No-op. This migration only re-anchors to PB_RULES, which is
    // already what 0001 + 0004 + 0024 produced; nothing to undo.
    console.log(
      "  [authz-strings] down(): no-op (migration only re-anchors)"
    );
  }
);
