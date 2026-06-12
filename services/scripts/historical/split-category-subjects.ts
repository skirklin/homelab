/**
 * Split category-shaped life_events into per-thing subjects (2026-06 life
 * redesign: one trackable per activity instead of a generic subject + a
 * `category` label).
 *
 * For events with subject_id in ("exercise", "focus"):
 *   - new subject_id = slugified labels.category
 *     ("PT" -> "pt", "trip planning" -> "trip-planning");
 *   - an `intensity` entry (if present) is renamed to `rating`
 *     (value/unit/scale preserved);
 *   - the `category` key is removed from labels (all other labels kept);
 *   - events missing labels.category are reported and left untouched;
 *   - events with BOTH intensity and rating entries are reported as
 *     conflicts and left untouched (the rename would duplicate names).
 *
 * Idempotent: only exercise/focus subject_ids are candidates, and a
 * rewritten event no longer matches (its subject is the category slug).
 *
 * Usage
 * -----
 *   export $(grep -v '^#' .env | xargs)
 *   pnpm tsx historical/split-category-subjects.ts [--log <id>] [--pb-url <url>] [--dry-run | --apply]
 *
 *   --log <id>   = scope to one life log (default: all logs).
 *   --pb-url     = PB base URL (default: $PB_URL or https://api.kirkl.in).
 *   --dry-run    = default; prints the per-event plan, changes nothing.
 *   --apply      = write for real.
 */
import { CATEGORY_SUBJECTS, localDayKey, planCategorySplit } from "./lib/life-rewrite";
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
  console.error("Usage: pnpm tsx historical/split-category-subjects.ts [--log <id>] [--pb-url <url>] [--dry-run | --apply]");
  process.exit(1);
}

console.log("==============================================");
console.log("  split category subjects (exercise/focus)");
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

const totals = { logs: 0, candidates: 0, rewrite: 0, missingCategory: 0, conflict: 0, errors: 0 };
const missingByLog: Array<{ logId: string; id: string; subjectId: string; day: string }> = [];

for (const log of logs) {
  const events = await fetchEvents(pb, log.id, [...CATEGORY_SUBJECTS]);
  totals.logs++;
  totals.candidates += events.length;

  console.log("");
  console.log(`  Log ${log.id} (owner ${log.ownerId || "?"}, tz ${log.tz}): ${events.length} exercise/focus events`);
  if (events.length === 0) {
    console.log("    nothing to do");
    continue;
  }

  for (const ev of events) {
    const day = localDayKey(ev.timestamp, log.tz);
    const action = planCategorySplit(ev);
    if (action.kind === "rewrite") {
      totals.rewrite++;
      console.log(
        `    ${day}  ${ev.id}  ${action.oldSubjectId} -> ${action.newSubjectId}` +
          `${action.renamedIntensity ? "  (intensity -> rating)" : ""}` +
          `  labels=${JSON.stringify(action.labels)}`,
      );
      if (!dryRun) {
        try {
          await pb.collection("life_events").update(
            ev.id,
            { subject_id: action.newSubjectId, entries: action.entries, labels: action.labels },
            { $autoCancel: false },
          );
        } catch (err: any) {
          totals.errors++;
          console.error(`      ERROR updating ${ev.id}: ${err.message}`);
        }
      }
    } else if (action.kind === "missing-category") {
      totals.missingCategory++;
      missingByLog.push({ logId: log.id, id: ev.id, subjectId: ev.subject_id, day });
      console.log(`    ${day}  ${ev.id}  ${ev.subject_id}: missing labels.category — left untouched`);
    } else {
      totals.conflict++;
      console.log(`    ${day}  ${ev.id}  ${ev.subject_id}: CONFLICT — ${action.reason} — left untouched`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log("  ---------- Summary ----------");
console.log(`  Logs processed:              ${totals.logs}`);
console.log(`  exercise/focus events seen:  ${totals.candidates}`);
console.log(`  rewritten:                   ${totals.rewrite}`);
console.log(`  missing labels.category:     ${totals.missingCategory}`);
console.log(`  conflicts (untouched):       ${totals.conflict}`);
if (!dryRun) console.log(`  apply errors:                ${totals.errors}`);

if (missingByLog.length > 0) {
  console.log("");
  console.log("  Events missing labels.category (untouched):");
  for (const m of missingByLog) {
    console.log(`    log=${m.logId}  ${m.day}  ${m.subjectId}  id=${m.id}`);
  }
}

if (dryRun) {
  console.log("");
  console.log("  Dry run: no changes written. Pass --apply to commit.");
}
process.exit(totals.errors > 0 ? 1 : 0);
