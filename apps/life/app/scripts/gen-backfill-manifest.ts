/**
 * Rewrite the GENERATED MANIFEST block inside the P1 backfill migration
 * (infra/pocketbase/pb_migrations/20260601_191856_life_manifest_column.js) from
 * the canonical TS backfill (apps/life/app/src/lib/manifest-backfill.ts).
 *
 * PB v0.25 migrations can't `require()` a TS/JS data module (goja_nodejs has no
 * filesystem resolver -> "Invalid module"), so the backfill payload must be
 * INLINED in the migration. This script keeps that inlined literal in sync with
 * the TS source; a vitest drift-check (manifest-backfill.test.ts) parses the
 * same block and fails if it diverges. Re-run after any TRACKABLES / mapping
 * change:
 *
 *   apps/life/app $ ../../../services/api/node_modules/.bin/tsx scripts/gen-backfill-manifest.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { backfillManifest } from "../src/lib/manifest-backfill";

const BEGIN = "/* BEGIN GENERATED MANIFEST -- do not hand-edit; run gen-backfill-manifest.ts */";
const END = "/* END GENERATED MANIFEST */";

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  here,
  "../../../../infra/pocketbase/pb_migrations/20260601_191856_life_manifest_column.js",
);

const src = readFileSync(migrationPath, "utf8");
const start = src.indexOf(BEGIN);
const end = src.indexOf(END);
if (start === -1 || end === -1 || end < start) {
  throw new Error(`Could not find GENERATED MANIFEST markers in ${migrationPath}`);
}

const literal = "const BACKFILL_MANIFEST = " + JSON.stringify(backfillManifest(), null, 2) + ";";
const block = BEGIN + "\n" + literal + "\n" + END;
const next = src.slice(0, start) + block + src.slice(end + END.length);

if (next !== src) {
  writeFileSync(migrationPath, next);
  console.log(`updated GENERATED MANIFEST block in ${migrationPath}`);
} else {
  console.log("GENERATED MANIFEST block already up to date");
}
