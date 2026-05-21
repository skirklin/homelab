/// <reference path="../pb_data/types.d.ts" />

/**
 * Collapse life_logs.owners (multi-relation) → life_logs.owner (single-relation).
 *
 * Background
 * ----------
 * life is a solo-user surface; the multi-owner shape on life_logs was
 * preemptive infrastructure for sharing that never paid rent. We are
 * removing life from the sharing surface entirely (no invites, no
 * /sharing/list-info, no /join-list), so the cardinality on the column
 * should match: exactly one owner per log.
 *
 * Steps (order matters):
 *   1. Add `owner` (relation→users, maxSelect=1, non-cascading, nullable for now).
 *   2. Backfill `owner = owners[0]` for every existing life_logs row.
 *   3. Re-anchor list/view/update/delete rules to use the single-relation
 *      form `owner = @request.auth.id` (not `?=`; the any-of operator
 *      only applies to multi-relations) AND promote `owner` to required.
 *      Must happen BEFORE dropping `owners` — PB validates that all rules
 *      resolve against existing fields on collection save, so attempting
 *      to drop `owners` while the rules still reference `owners.id` errors
 *      out with "failed to resolve field `owners`".
 *   4. Drop the old `owners` field (rules no longer reference it).
 *   5. Update life_events child rules from `log.owners.id ?= …` to
 *      `log.owner = …`.
 *
 * Cross-references that must move in lockstep:
 *   - infra/pocketbase/pb_migrations/lib/authz-rules.js  (PB_RULES source of truth)
 *   - services/api/src/e2e/authz-mirror.test.ts          (property test pins drift)
 *   - services/api/src/lib/authz.ts → userOwnsLifeLog    (admin-PB ownership gate)
 *   - packages/backend/src/pocketbase/life.ts            (getOrCreateLog)
 *   - services/api/src/lib/notifications/life.ts         (logDoc.owners reads)
 *   - services/api/src/routes/sharing.ts                 (drop life_logs from `allowed`)
 *   - services/api/src/index.ts                          (drop life_logs from /sharing/list-info)
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    const usersCol = app.findCollectionByNameOrId("users");
    const usersId = usersCol.id;

    // ---- (1) Add `owner` single-relation field ----
    // Created NOT required so the backfill in (2) can run; we promote to
    // required after backfill via a second save below. PB rejects saving
    // a row with a missing required relation, and required fields on a
    // pre-existing table also reject creation if any row lacks a value.
    if (!col.fields.getByName("owner")) {
      col.fields.add(
        new Field({
          type: "relation",
          name: "owner",
          collectionId: usersId,
          maxSelect: 1,
          cascadeDelete: false,
          required: false,
        }),
      );
      app.save(col);
      console.log("  life_logs: added owner (single-relation, nullable)");
    } else {
      console.log("  life_logs: owner field already exists, skipping add");
    }

    // ---- (2) Backfill owner = owners[0] ----
    // Iterate via the model API rather than raw SQL so PB's relation
    // storage layout (which is opaque) is updated through the supported
    // path. Volume is tiny (solo user → 1 row), so the cost is irrelevant.
    const rows = app.findAllRecords("life_logs");
    let backfilled = 0;
    let alreadySet = 0;
    let empty = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.get("owner")) {
        alreadySet += 1;
        continue;
      }
      const owners = r.get("owners") || [];
      if (!owners || owners.length === 0) {
        // Orphan row with no owners — leave owner empty. Will surface as
        // a required-field violation when (3) runs, which is the right
        // failure mode: we'd rather the migration fail loudly than
        // silently drop an orphan log.
        empty += 1;
        continue;
      }
      r.set("owner", owners[0]);
      app.save(r);
      backfilled += 1;
    }
    console.log(
      "  life_logs: backfilled owner on " +
        backfilled +
        " row(s) (already set: " +
        alreadySet +
        ", empty owners: " +
        empty +
        ")",
    );

    // ---- (3) Promote `owner` to required + update life_logs rules ----
    // Must happen BEFORE dropping `owners`: PB validates rule fields on
    // collection save, and the existing rules still reference owners.id.
    // Once rules point at the new `owner` field, the owners drop in (4)
    // passes validation.
    {
      const fresh = app.findCollectionByNameOrId("life_logs");
      const ownerField = fresh.fields.getByName("owner");
      if (ownerField && !ownerField.required) {
        ownerField.required = true;
        console.log("  life_logs: marked owner as required");
      }

      const OWNER_RULE = '@request.auth.id != "" && owner = @request.auth.id';
      fresh.listRule = OWNER_RULE;
      fresh.viewRule = OWNER_RULE;
      fresh.createRule = '@request.auth.id != ""';
      fresh.updateRule = OWNER_RULE;
      fresh.deleteRule = OWNER_RULE;
      app.save(fresh);
      console.log("  life_logs: rules re-anchored to single-owner shape");
    }

    // ---- (4) Drop the old `owners` field ----
    {
      const fresh = app.findCollectionByNameOrId("life_logs");
      const ownersField = fresh.fields.getByName("owners");
      if (ownersField) {
        fresh.fields.removeById(ownersField.id);
        app.save(fresh);
        console.log("  life_logs: dropped owners field");
      } else {
        console.log("  life_logs: owners field already absent, skipping drop");
      }
    }

    // ---- (5) Update life_events child rules ----
    {
      const events = app.findCollectionByNameOrId("life_events");
      const CHILD_RULE = '@request.auth.id != "" && log.owner = @request.auth.id';
      events.listRule = CHILD_RULE;
      events.viewRule = CHILD_RULE;
      events.createRule = CHILD_RULE;
      events.updateRule = CHILD_RULE;
      events.deleteRule = CHILD_RULE;
      app.save(events);
      console.log("  life_events: rules re-anchored to log.owner shape");
    }
  },
  (app) => {
    // Reverse the structural changes so a `pb migrate down` lands somewhere
    // sensible. We re-create owners as a multi-relation, backfill owners
    // = [owner], drop owner, and restore the old ?= rule strings.
    //
    // Sharing-related code is NOT restored — if you really want multi-owner
    // life back you'll need to manually revert the TS and pb_hooks changes
    // too. The data side of the down() is the cheap-and-helpful part.
    const col = app.findCollectionByNameOrId("life_logs");
    const usersCol = app.findCollectionByNameOrId("users");
    const usersId = usersCol.id;

    if (!col.fields.getByName("owners")) {
      col.fields.add(
        new Field({
          type: "relation",
          name: "owners",
          collectionId: usersId,
          maxSelect: 100,
          cascadeDelete: false,
          required: false,
        }),
      );
      app.save(col);
      console.log("  [down] life_logs: re-added owners (multi-relation)");
    }

    const rows = app.findAllRecords("life_logs");
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const owner = r.get("owner");
      const existing = r.get("owners") || [];
      if (owner && existing.indexOf(owner) === -1) {
        r.set("owners", [owner]);
        app.save(r);
      }
    }
    console.log("  [down] life_logs: backfilled owners from owner");

    {
      const fresh = app.findCollectionByNameOrId("life_logs");
      const ownersField = fresh.fields.getByName("owners");
      if (ownersField && !ownersField.required) {
        ownersField.required = true;
      }
      const ownerField = fresh.fields.getByName("owner");
      if (ownerField) {
        fresh.fields.removeById(ownerField.id);
      }
      const OWNER_RULE = '@request.auth.id != "" && @request.auth.id ?= owners.id';
      fresh.listRule = OWNER_RULE;
      fresh.viewRule = OWNER_RULE;
      fresh.createRule = '@request.auth.id != ""';
      fresh.updateRule = OWNER_RULE;
      fresh.deleteRule = OWNER_RULE;
      app.save(fresh);
      console.log("  [down] life_logs: rules + fields restored");
    }

    {
      const events = app.findCollectionByNameOrId("life_events");
      const CHILD_RULE =
        '@request.auth.id != "" && @request.auth.id ?= log.owners.id';
      events.listRule = CHILD_RULE;
      events.viewRule = CHILD_RULE;
      events.createRule = CHILD_RULE;
      events.updateRule = CHILD_RULE;
      events.deleteRule = CHILD_RULE;
      app.save(events);
      console.log("  [down] life_events: rules restored");
    }
  },
);
