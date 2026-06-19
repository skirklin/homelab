/**
 * Phase D, part 3 — copy each life log's legacy `*_reminder_time` columns into
 * `manifest.notifications[]`, making the per-user notification manifest the
 * source of truth. This is the IRREVERSIBLE data step: crash-safe, idempotent,
 * dry-run-by-default.
 *
 * WHY IT'S SAFE: the B4 cron resolves a log's notifications as
 * `manifest.notifications ?? buildNotificationsFromColumns(log)`. This migration
 * materializes EXACTLY `buildNotificationsFromColumns(log)` into the manifest,
 * so the resolved notifications are byte-identical to today's column fallback →
 * ZERO change in send decisions. We reuse `buildNotificationsFromColumns`
 * verbatim, so the `*-reminder` ids + real column times + weekly
 * subsumes/weekday are preserved and the `reminder_state` double-fire guard
 * keeps matching. (Seeding `DEFAULT_NOTIFICATIONS` — bare ids + placeholder
 * times — would break that guard; see the landmine doc in
 * services/api/src/lib/notifications/life-notifications.ts.)
 *
 * BACKUP FIRST. This script does NOT take a backup — the operator runs
 * `infra/scripts/pb-backup.sh pre-migration-reminder-columns` (kept forever) BEFORE --apply.
 *
 * Usage
 * -----
 *   export $(grep -v '^#' .env | xargs)
 *   pnpm tsx historical/migrate-reminder-columns-to-notifications.ts \
 *       [--log <id>] [--pb-url <url>] [--dry-run | --apply]
 *
 *   --log <id>   = scope to one life log (hard-error if it doesn't exist).
 *   --pb-url     = PB base URL (default: $PB_URL or https://api.kirkl.in).
 *   --dry-run    = default; prints the plan, changes nothing.
 *   --apply      = write for real.
 *
 * Idempotent: a log whose `manifest.notifications` is already an array is
 * skipped, so a second --apply is a no-op.
 *
 * Exit codes (per the §4 / sibling-script convention): 0 = clean (every log
 * migrated or already-migrated, no errors), 1 = errors (bad args, auth/apply
 * failures). A "skip" here means "already migrated" — the idempotent re-run
 * case, NOT an unresolved-conflict needing review — so skips never raise the
 * exit code (unlike merge-sleep-quality's exit 2, which flagged genuine data
 * conflicts this migration cannot produce).
 */
import { takeFlag, takeOpt } from "./lib/cli";
import { connectAdmin } from "./lib/pb-admin";
import { type RawLifeLog, planReminderMigration } from "./lib/reminder-migration";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const USAGE =
  "Usage: pnpm tsx historical/migrate-reminder-columns-to-notifications.ts [--log <id>] [--pb-url <url>] [--dry-run | --apply]";

let onlyLogId: string | undefined;
let apply = false;
let dryRun = true;
let pbUrl = "";
try {
  onlyLogId = takeOpt(argv, "--log");
  apply = takeFlag(argv, "--apply");
  dryRun = takeFlag(argv, "--dry-run") || !apply;
  pbUrl = takeOpt(argv, "--pb-url") || process.env.PB_URL || `https://api.${process.env.DOMAIN || "kirkl.in"}`;
} catch (err: any) {
  console.error(err.message);
  console.error(USAGE);
  process.exit(1);
}

if (argv.length > 0) {
  console.error(`Unknown args: ${argv.join(" ")}`);
  console.error(USAGE);
  process.exit(1);
}

console.log("==================================================");
console.log("  migrate *_reminder_time columns -> manifest.notifications");
console.log("==================================================");
console.log(`  PB URL:     ${pbUrl}`);
console.log(`  Scope:      ${onlyLogId ? `log ${onlyLogId}` : "all life logs"}`);
console.log(`  Mode:       ${dryRun ? "DRY-RUN" : "APPLY"}`);
console.log("");
console.log("  !! BACKUP FIRST — before --apply, the operator must take a");
console.log("  !! pre-migration backup (kept forever):");
console.log("  !!     infra/scripts/pb-backup.sh pre-migration");
console.log("  !! This script never takes the backup itself.");
console.log("");

const pb = await connectAdmin(pbUrl);

// Fetch raw life_logs records. We need the snake_case columns + the full
// parsed `manifest` JSON, which the shared resolveLogs() does not carry — so
// we read the records directly. `getOne` hard-errors on a missing --log id.
let records: RawLifeLog[];
try {
  const raw = onlyLogId
    ? [await pb.collection("life_logs").getOne(onlyLogId, { $autoCancel: false })]
    : await pb.collection("life_logs").getFullList({ $autoCancel: false });
  records = raw.map((r) => ({
    id: r.id,
    manifest: (r.manifest ?? null) as RawLifeLog["manifest"],
    morning_reminder_time: (r.morning_reminder_time as string | null | undefined) ?? undefined,
    evening_reminder_time: (r.evening_reminder_time as string | null | undefined) ?? undefined,
    weekly_reminder_time: (r.weekly_reminder_time as string | null | undefined) ?? undefined,
    random_sampling_enabled: Boolean(r.random_sampling_enabled),
  }));
} catch (err: any) {
  console.error(`Failed to fetch life_logs: ${err.message}`);
  process.exit(1);
}

console.log(`  Logs to process: ${records.length}`);
console.log("");

// ---------------------------------------------------------------------------
// Plan + report + apply
// ---------------------------------------------------------------------------

const actions = planReminderMigration(records);
const totals = { logs: records.length, migrate: 0, skip: 0, errors: 0 };
let sampleShown = false;

for (const a of actions) {
  if (a.kind === "skip") {
    totals.skip++;
    console.log(`  SKIP    ${a.logId}: ${a.reason}`);
    continue;
  }
  totals.migrate++;
  const ids = a.notifications.map((n) => n.id);
  console.log(`  MIGRATE ${a.logId}: notifications=[${ids.join(", ") || "(none)"}]`);
  // Show one full sample of the computed notifications so the operator can
  // eyeball the *-reminder id scheme + real times before committing.
  if (!sampleShown && a.notifications.length > 0) {
    sampleShown = true;
    console.log("    sample notifications:");
    console.log(JSON.stringify(a.notifications, null, 2).replace(/^/gm, "    "));
  }
}

if (!dryRun) {
  console.log("");
  console.log("  Applying writes...");
  for (const a of actions) {
    if (a.kind !== "migrate") continue;
    try {
      // Sequential awaits + $autoCancel:false: N concurrent updates to one
      // collection auto-cancel each other ("Failed to save"). One at a time is
      // the safe, simple path.
      await pb.collection("life_logs").update(a.logId, { manifest: a.nextManifest }, { $autoCancel: false });
    } catch (err: any) {
      totals.errors++;
      console.error(`    ERROR updating ${a.logId}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log("  ---------- Summary ----------");
console.log(`  Logs processed:            ${totals.logs}`);
console.log(`  migrate (write manifest):  ${totals.migrate}`);
console.log(`  skip (already migrated):   ${totals.skip}`);
if (!dryRun) console.log(`  apply errors:              ${totals.errors}`);

if (dryRun) {
  console.log("");
  console.log("  Dry run: no changes written. Pass --apply to commit.");
  console.log("  (Take a pre-migration backup FIRST — see the banner above.)");
}

// 1 = apply errors; 0 = clean. Skips are the idempotent already-migrated case
// (re-run no-op), never an error.
process.exit(totals.errors > 0 ? 1 : 0);
