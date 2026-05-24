/**
 * Recover cooking-log notes wiped by the 20260522_230100 recipe_events
 * unified-shape migration.
 *
 * Background
 * ----------
 * The 2026-05-22 migration converted `recipe_events.data.notes` (string) into
 * the unified `entries: [{name,type,value}]` shape, then dropped the `data`
 * column. The conversion loop had the exact same goja []byte handling bug as
 * the life_events migration that landed the same day:
 *
 *     raw = JSON.parse(JSON.stringify(r.get("data") || {}));
 *     const notes = typeof raw.notes === "string" && raw.notes.length > 0
 *                     ? raw.notes : null;
 *
 * PB exposes JSON columns to goja as a byte array, so the round-trip leaves
 * `raw` as an array-of-numbers. `typeof raw.notes` is therefore `"undefined"`,
 * the `if (notes)` branch never fires, and every row landed with
 * `entries: []`. The original `data` column was then dropped, so the live PB
 * row has no copy of the notes — recovery requires the pre-migration backup.
 *
 * A direct sqlite query against `pre-migration-20260419-135430.zip` confirmed
 * 31 of 35 pre-migration recipe_events rows had substantive notes (cooking
 * modifications like "Used Yukon gold potatoes, 3 tbsp roux", "Doubled the
 * eggs", etc). This script rehydrates them.
 *
 * Sister script
 * -------------
 * `services/scripts/recover-life-events.ts` is the canonical pattern from the
 * May-22 incident. See its header for a longer write-up of the underlying
 * goja byte-array bug and the recovery approach. This script reuses the same
 * sqlite3-CLI-via-execFileSync trick (better-sqlite3 hit an ABI mismatch on
 * the dev box; the CLI ships with the system) and the same superuser-auth +
 * PATCH pattern.
 *
 * Recovery rule
 * -------------
 *   - Pull rows from backup where `json_extract(data, '$.notes')` is a
 *     non-empty string.
 *   - **Match on timestamp**, not id. The backup pre-dates the Firebase→PB
 *     ID renumbering, so ids changed but timestamps (ms precision) survived
 *     intact. Backup row at "2025-12-30 21:17:26.542Z" maps to the current
 *     PB row at the same exact timestamp.
 *   - If exactly 1 PB row matches the timestamp, PATCH it.
 *   - Only PATCH if the current row has empty `entries` (length 0 or null).
 *     If someone added notes after the migration, do NOT overwrite — log
 *     and skip.
 *   - Write back as
 *     `{ entries: [{name: "notes", type: "text", value: <backupNotes>}] }`.
 *
 * Idempotency
 * -----------
 * Because the recovery rule requires empty entries on the current row, a
 * second run will see the just-written entries and skip them. Safe to re-run.
 *
 * Authored 2026-05-24.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

// ---------------------------------------------------------------------------
// CLI + env
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function takeOpt(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const val = argv[i + 1];
  argv.splice(i, 2);
  return val;
}

function takeFlag(name: string): boolean {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

const backupPath = takeOpt("--backup") || "/tmp/recover-recipe/data.db";
const pbUrl = takeOpt("--pb") || process.env.PB_URL || "https://api.kirkl.in";
const dryRun = takeFlag("--dry-run");

if (argv.length > 0) {
  console.error(`Unknown args: ${argv.join(" ")}`);
  console.error("Usage: pnpm tsx recover-recipe-events.ts [--backup <path>] [--pb <url>] [--dry-run]");
  process.exit(1);
}

try {
  const st = statSync(backupPath);
  if (!st.isFile()) {
    console.error(`Backup path is not a file: ${backupPath}`);
    process.exit(1);
  }
} catch (err: any) {
  console.error(`Backup not readable: ${backupPath}: ${err.message}`);
  process.exit(1);
}

const adminEmail = process.env.PB_ADMIN_EMAIL || "scott.kirklin@gmail.com";
const adminPassword = process.env.PB_ADMIN_PASSWORD;
if (!adminPassword) {
  console.error("PB_ADMIN_PASSWORD not set (source .env first)");
  process.exit(1);
}

console.log("==============================================");
console.log("  recipe_events recovery");
console.log("==============================================");
console.log(`  PB URL:   ${pbUrl}`);
console.log(`  Backup:   ${backupPath}`);
console.log(`  Admin:    ${adminEmail}`);
console.log(`  Mode:     ${dryRun ? "DRY-RUN" : "APPLY"}`);
console.log("");

// ---------------------------------------------------------------------------
// sqlite via CLI (avoids better-sqlite3 NODE_MODULE_VERSION ABI mismatch)
// ---------------------------------------------------------------------------

function sqliteAll<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], {
    maxBuffer: 100 * 1024 * 1024,
  }).toString();
  if (!out.trim()) return [];
  return JSON.parse(out) as T[];
}

// ---------------------------------------------------------------------------
// PB auth + helpers (plain fetch — no SDK dep needed for this surface)
// ---------------------------------------------------------------------------

interface AuthResponse {
  token: string;
}

async function authSuperuser(): Promise<string> {
  const url = `${pbUrl}/api/collections/_superusers/auth-with-password`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: adminEmail, password: adminPassword }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`auth ${res.status}: ${body}`);
  }
  const json = (await res.json()) as AuthResponse;
  return json.token;
}

interface RecipeEventRow {
  id: string;
  timestamp: string;
  entries: Array<{ name: string; type: string; value: unknown }> | null;
}

interface RecipeEventList {
  items: RecipeEventRow[];
  totalItems: number;
}

async function findRecipeEventsByTimestamp(token: string, timestamp: string): Promise<RecipeEventRow[]> {
  // PB filter values use double quotes; the timestamp string itself contains
  // none, so a direct interpolation is safe here.
  const filter = `timestamp = "${timestamp}"`;
  const url =
    `${pbUrl}/api/collections/recipe_events/records?perPage=10&filter=` +
    encodeURIComponent(filter);
  const res = await fetch(url, { headers: { Authorization: token } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LIST ts=${timestamp} ${res.status}: ${body}`);
  }
  const json = (await res.json()) as RecipeEventList;
  return json.items;
}

async function patchRecipeEvent(
  token: string,
  id: string,
  notes: string,
): Promise<{ ok: true } | { ok: false; status: number; body: string }> {
  const url = `${pbUrl}/api/collections/recipe_events/records/${encodeURIComponent(id)}`;
  const body = JSON.stringify({
    entries: [{ name: "notes", type: "text", value: notes }],
  });
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: token },
    body,
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => "");
  return { ok: false, status: res.status, body: text };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const token = await authSuperuser();
console.log("  PB auth OK");

// Pull every backup row whose data.notes is a non-empty string. `json_extract`
// returns NULL when the path is missing or the value is not a scalar string —
// the `!= ''` guard drops empty strings as well.
const backupRows = sqliteAll<{ id: string; timestamp: string; notes: string }>(
  backupPath,
  "SELECT id, timestamp, json_extract(data, '$.notes') AS notes FROM recipe_events " +
    "WHERE json_extract(data, '$.notes') IS NOT NULL " +
    "AND json_extract(data, '$.notes') != ''",
);
console.log(`  Backup rows with notes: ${backupRows.length}`);
console.log("");

let recovered = 0;
let skipped = 0;
let missing = 0;
let ambiguous = 0;
let errors = 0;

for (const row of backupRows) {
  if (typeof row.notes !== "string" || row.notes.length === 0) {
    // Shouldn't happen given the SQL filter, but guard anyway.
    skipped++;
    console.log(`  skipped backup-id=${row.id} (backup notes empty)`);
    continue;
  }

  let matches: RecipeEventRow[];
  try {
    matches = await findRecipeEventsByTimestamp(token, row.timestamp);
  } catch (err: any) {
    errors++;
    console.log(`  error  ts=${row.timestamp} (LIST: ${err.message})`);
    continue;
  }

  if (matches.length === 0) {
    missing++;
    console.log(`  missing ts=${row.timestamp} (no current PB row at that timestamp)`);
    continue;
  }
  if (matches.length > 1) {
    ambiguous++;
    console.log(`  ambiguous ts=${row.timestamp} (${matches.length} matches; manual review needed)`);
    continue;
  }

  const current = matches[0];
  const entries = Array.isArray(current.entries) ? current.entries : [];
  if (entries.length > 0) {
    skipped++;
    console.log(`  skipped current-id=${current.id} (already has entries)`);
    continue;
  }

  if (dryRun) {
    recovered++;
    console.log(`  would recover current-id=${current.id} (${row.notes.length} chars)`);
    continue;
  }

  const result = await patchRecipeEvent(token, current.id, row.notes);
  if (result.ok) {
    recovered++;
    console.log(`  recovered current-id=${current.id}`);
  } else {
    errors++;
    console.log(`  error  current-id=${current.id} (PATCH ${result.status}: ${result.body})`);
  }
}

console.log("");
console.log(`recovered=${recovered} skipped=${skipped} missing=${missing} ambiguous=${ambiguous} errors=${errors}`);
process.exit(errors > 0 ? 1 : 0);
