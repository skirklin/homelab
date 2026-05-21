/// <reference path="../pb_data/types.d.ts" />

/**
 * Enforce the one-life-log-per-user invariant at the DB layer.
 *
 * Background
 * ----------
 * Migration 0028 collapsed life_logs to a single `owner` relation, and
 * `getOrCreateLog` (packages/backend/src/pocketbase/life.ts) treats "the
 * row where owner = userId" as authoritative. The "one log per user"
 * invariant has been application-only since then: two parallel calls
 * for the same user can both miss the recovery lookup and create
 * duplicate rows, leaving subsequent lookups picking an arbitrary
 * winner via `sort=created` order.
 *
 * A UNIQUE(owner) index closes the race at the DB layer (the second
 * create fails with a constraint violation, caller retries the lookup
 * and finds the row written by the first call) and makes the
 * "exactly one log per user" property provable from the schema.
 *
 * Defensive de-dup
 * ----------------
 * If duplicate-owner rows already exist, the UNIQUE add would silently
 * fail at PB save time. We scan up-front and abort loudly so the data
 * stewards make the merge decision, not the migration. Solo-user surface
 * today means this is a no-op assertion.
 *
 * down() drops the index. We do NOT recreate any duplicate rows that
 * may have been merged out — the abort in up() ensures we never silently
 * lost data, so there's nothing to restore.
 */

const INDEX_NAME = "idx_life_logs_owner";
const INDEX_SQL = `CREATE UNIQUE INDEX ${INDEX_NAME} ON life_logs (owner)`;

migrate(
  (app) => {
    // ---- Defensive duplicate-owner scan ----
    // Group existing rows by owner; any owner with >1 row blocks the add.
    const rows = app.findAllRecords("life_logs");
    const byOwner = {};
    for (let i = 0; i < rows.length; i++) {
      const owner = rows[i].get("owner");
      if (!owner) continue; // 0028 made it required, but be paranoid
      if (!byOwner[owner]) byOwner[owner] = [];
      byOwner[owner].push(rows[i].id);
    }
    const dupOwners = Object.keys(byOwner).filter((o) => byOwner[o].length > 1);
    if (dupOwners.length > 0) {
      const detail = dupOwners
        .map((o) => `    owner=${o} → logs=${byOwner[o].join(", ")}`)
        .join("\n");
      throw new Error(
        "0031_life_logs_unique_owner: refusing to add UNIQUE(owner); " +
          dupOwners.length +
          " owner(s) have duplicate life_logs rows. Resolve manually before re-running:\n" +
          detail,
      );
    }
    console.log("  life_logs: no duplicate-owner rows; safe to add UNIQUE index");

    // ---- Add the unique index ----
    const col = app.findCollectionByNameOrId("life_logs");
    const existing = (col.indexes || []).find((i) => i.includes(INDEX_NAME));
    if (existing) {
      console.log("  life_logs: " + INDEX_NAME + " already present, skipping");
      return;
    }
    col.indexes = [...(col.indexes || []), INDEX_SQL];
    app.save(col);
    console.log("  life_logs: added UNIQUE index on owner");
  },
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    const before = (col.indexes || []).length;
    col.indexes = (col.indexes || []).filter((i) => !i.includes(INDEX_NAME));
    if (col.indexes.length !== before) {
      app.save(col);
      console.log("  [down] life_logs: dropped " + INDEX_NAME);
    } else {
      console.log("  [down] life_logs: " + INDEX_NAME + " not present, skipping");
    }
  },
);
