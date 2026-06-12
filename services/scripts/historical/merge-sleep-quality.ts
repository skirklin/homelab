/**
 * Merge standalone `sleep_quality` life_events into the same local day's
 * `sleep` event (2026-06 life redesign: quality becomes a `rating` entry on
 * the sleep event itself; the separate sleep_quality trackable goes away).
 *
 * Per log, per local day (owner's timezone, default America/Los_Angeles):
 *   - rating folds into the day's LONGEST sleep event as
 *     { name: "rating", type: "number", value: 1-5, unit: "rating", scale: 5 },
 *     then the sleep_quality event is DELETED;
 *   - if the target sleep already has a rating entry → reported as a
 *     conflict, nothing changes (unless the rating is identical — then the
 *     quality event is just deleted, which heals an interrupted prior run);
 *   - if the day has no sleep event → a sleep event is CREATED at the
 *     quality event's timestamp carrying only the rating (no duration);
 *   - non-rating entries on the quality event (e.g. notes) ride along onto
 *     the sleep event so deleting loses nothing.
 *
 * Idempotent: sleep_quality events are the work queue; once deleted, reruns
 * find nothing to do. Crash-safe ordering (write sleep first, delete quality
 * second) means a rerun after a mid-run crash sees the identical rating and
 * plans delete-only.
 *
 * Usage
 * -----
 *   export $(grep -v '^#' .env | xargs)
 *   pnpm tsx historical/merge-sleep-quality.ts [--log <id>] [--pb-url <url>] [--dry-run | --apply]
 *
 *   --log <id>   = scope to one life log (default: all logs).
 *   --pb-url     = PB base URL (default: $PB_URL or https://api.kirkl.in).
 *   --dry-run    = default; prints the per-day plan, changes nothing.
 *   --apply      = write for real.
 */
import {
  type SleepMergeAction,
  planSleepMerge,
} from "./lib/life-rewrite";
import { connectAdmin, fetchEvents, resolveLogs } from "./lib/pb-admin";

// ---------------------------------------------------------------------------
// CLI (same takeOpt/takeFlag shape as recover-life-events.ts)
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

const onlyLogId = takeOpt("--log");
const apply = takeFlag("--apply");
const dryRun = takeFlag("--dry-run") || !apply;
const pbUrl = takeOpt("--pb-url") || process.env.PB_URL || `https://api.${process.env.DOMAIN || "kirkl.in"}`;

if (argv.length > 0) {
  console.error(`Unknown args: ${argv.join(" ")}`);
  console.error("Usage: pnpm tsx historical/merge-sleep-quality.ts [--log <id>] [--pb-url <url>] [--dry-run | --apply]");
  process.exit(1);
}

console.log("==============================================");
console.log("  merge sleep_quality -> sleep");
console.log("==============================================");
console.log(`  PB URL:     ${pbUrl}`);
console.log(`  Scope:      ${onlyLogId ? `log ${onlyLogId}` : "all life logs"}`);
console.log(`  Mode:       ${dryRun ? "DRY-RUN" : "APPLY"}`);
console.log("");

const pb = await connectAdmin(pbUrl);
const logs = await resolveLogs(pb, onlyLogId);
console.log(`  Logs to process: ${logs.length}`);

// ---------------------------------------------------------------------------
// Plan + report + apply, per log
// ---------------------------------------------------------------------------

function describe(a: SleepMergeAction): string {
  switch (a.kind) {
    case "attach":
      return `attach       quality=${a.qualityId} -> sleep=${a.sleepId} (rating ${a.rating}${
        a.carried.length > 0 ? `, carried: ${a.carried.join(",")}` : ""})`;
    case "create":
      return `create       quality=${a.qualityId} -> NEW sleep @ ${a.event.timestamp} (rating ${a.rating}, no duration)`;
    case "delete-only":
      return `delete-only  quality=${a.qualityId} (sleep=${a.sleepId} already has rating ${a.rating})`;
    case "conflict":
      return `CONFLICT     quality=${a.qualityId}${a.sleepId ? ` vs sleep=${a.sleepId}` : ""}: ${a.reason}`;
    case "skip":
      return `SKIP         quality=${a.qualityId}: ${a.reason}`;
  }
}

const totals = { logs: 0, qualities: 0, sleeps: 0, attach: 0, create: 0, deleteOnly: 0, conflict: 0, skip: 0, errors: 0 };

for (const log of logs) {
  const events = await fetchEvents(pb, log.id, ["sleep", "sleep_quality"]);
  const sleeps = events.filter((e) => e.subject_id === "sleep").length;
  const qualities = events.filter((e) => e.subject_id === "sleep_quality").length;
  totals.logs++;
  totals.sleeps += sleeps;
  totals.qualities += qualities;

  console.log("");
  console.log(`  Log ${log.id} (owner ${log.ownerId || "?"}, tz ${log.tz}): ${sleeps} sleep, ${qualities} sleep_quality`);
  if (qualities === 0) {
    console.log("    nothing to do");
    continue;
  }

  const actions = planSleepMerge(events, log.tz);
  let day = "";
  for (const a of actions) {
    if (a.day !== day) {
      day = a.day;
      console.log(`    ${day}`);
    }
    console.log(`      ${describe(a)}`);
    if (a.kind === "attach") totals.attach++;
    else if (a.kind === "create") totals.create++;
    else if (a.kind === "delete-only") totals.deleteOnly++;
    else if (a.kind === "conflict") totals.conflict++;
    else totals.skip++;
  }

  if (dryRun) continue;

  // Apply. Ordering per action: write the sleep side FIRST, delete the
  // quality event SECOND — a crash in between leaves a rerun-healable state
  // (identical rating -> delete-only), never lost data.
  for (const a of actions) {
    try {
      if (a.kind === "attach") {
        await pb.collection("life_events").update(a.sleepId, { entries: a.newEntries }, { $autoCancel: false });
        await pb.collection("life_events").delete(a.qualityId, { $autoCancel: false });
      } else if (a.kind === "create") {
        await pb.collection("life_events").create(
          {
            log: log.id,
            subject_id: a.event.subject_id,
            timestamp: a.event.timestamp,
            entries: a.event.entries,
            ...(a.event.labels ? { labels: a.event.labels } : {}),
            ...(a.event.created_by ? { created_by: a.event.created_by } : {}),
          },
          { $autoCancel: false },
        );
        await pb.collection("life_events").delete(a.qualityId, { $autoCancel: false });
      } else if (a.kind === "delete-only") {
        await pb.collection("life_events").delete(a.qualityId, { $autoCancel: false });
      }
    } catch (err: any) {
      totals.errors++;
      console.error(`      ERROR applying ${a.kind} for quality=${a.qualityId}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log("  ---------- Summary ----------");
console.log(`  Logs processed:            ${totals.logs}`);
console.log(`  sleep events seen:         ${totals.sleeps}`);
console.log(`  sleep_quality events seen: ${totals.qualities}`);
console.log(`  attach (merge + delete):   ${totals.attach}`);
console.log(`  create (new sleep):        ${totals.create}`);
console.log(`  delete-only (healed):      ${totals.deleteOnly}`);
console.log(`  conflicts (untouched):     ${totals.conflict}`);
console.log(`  skipped (untouched):       ${totals.skip}`);
if (!dryRun) console.log(`  apply errors:              ${totals.errors}`);

if (dryRun) {
  console.log("");
  console.log("  Dry run: no changes written. Pass --apply to commit.");
}
process.exit(totals.errors > 0 ? 1 : 0);
