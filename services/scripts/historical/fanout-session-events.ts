/**
 * Fan each fat `*_session` life_event OUT into N per-item `life_events` rows
 * (one per prompt entry), then DELETE the source. This is the Phase-B3.1
 * cutover from one-fat-event sessions to the per-item, label-correlated View
 * model (apps/life/UNIFIED_CAPTURE_DESIGN.md §4).
 *
 * Per `*_session` event, per entry:
 *   - the entry's legacy name maps (SESSION_ID_MAP) to a new per-item
 *     subject_id; the entry is normalized to that id's canonical shape
 *     (RATED ids → `{name:"rating", unit:"rating", scale}`; everything else →
 *     `{name:"note", type:"text"}`);
 *   - the child carries `labels = {source, view, view_run: <source.timestamp>}`
 *     where `view` is morning|evening|weekly and `view_run` correlates the
 *     run's N children;
 *   - timestamp + created_by are copied from the source.
 * After all children for a source exist, the source is DELETED — ordered LAST.
 *
 * Idempotency is PER CHILD, keyed on `(subject_id, labels.view_run)`. A
 * partial/crashed run (some children present) creates only the MISSING ones,
 * then deletes the source. Real `mood` sampling events have no `view_run`, so
 * they're never mistaken for children and never block a migrated mood child.
 *
 * The planner HARD-FAILS on any entry name without a disposition in
 * SESSION_ID_MAP: that source's children are NOT created, the source is NOT
 * deleted, and the run exits non-zero. Nothing is ever silently dropped.
 *
 * Usage
 * -----
 *   export $(grep -v '^#' .env | xargs)
 *   pnpm tsx historical/fanout-session-events.ts [--log <id>] [--pb-url <url>] [--dry-run | --apply]
 *
 *   --log <id>   = scope to one life log (default: all logs).
 *   --pb-url     = PB base URL (default: $PB_URL or https://api.kirkl.in).
 *   --dry-run    = default; prints the per-source plan, changes nothing.
 *   --apply      = write for real (children FIRST, source deleted LAST).
 *
 * Exit codes: 0 = clean, 1 = errors (bad args, unmapped entries, apply
 * failures), 2 = --apply finished but left sources unresolved (review needed).
 */
import { takeFlag, takeOpt } from "./lib/cli";
import {
  SESSION_SUBJECTS,
  type SessionFanoutAction,
  planSessionFanout,
} from "./lib/life-rewrite";
import { connectAdmin, fetchEvents, resolveLogs } from "./lib/pb-admin";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const USAGE = "Usage: pnpm tsx historical/fanout-session-events.ts [--log <id>] [--pb-url <url>] [--dry-run | --apply]";

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

console.log("==============================================");
console.log("  fanout *_session -> per-item life_events");
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

function describe(a: SessionFanoutAction): string {
  switch (a.kind) {
    case "create": {
      const e = a.child.entries[0];
      const val = e.type === "number" ? `${e.value}/${e.scale ?? 5}` : JSON.stringify(e.value);
      return `create       ${a.subject}.${a.entryName} -> ${a.child.subjectId} {${e.name}=${val}} (view=${a.child.labels.view}, view_run=${a.child.labels.view_run})`;
    }
    case "skip":
      return `skip         ${a.subject}.${a.entryName} -> ${a.subjectId} (child already exists)`;
    case "delete-source":
      return `delete-source source=${a.sourceId} (${a.subject}) — all children present`;
    case "delete-only":
      return `delete-only  source=${a.sourceId} (${a.subject}) — already fully migrated`;
    case "error":
      return `ERROR        ${a.subject}.${a.entryName}: ${a.reason}`;
  }
}

const totals = {
  logs: 0,
  sources: 0,
  create: 0,
  skip: 0,
  deleteSource: 0,
  deleteOnly: 0,
  error: 0,
  applyErrors: 0,
};

for (const log of logs) {
  // Fetch the fat session sources AND every prior-run child (anything carrying
  // labels.view_run). We can't filter view_run in the PB query, so fetch ALL
  // of the log's events and split source vs child in code — volume is small.
  const events = await fetchEvents(pb, log.id, [...SESSION_SUBJECTS]);
  const allEvents = await pb.collection("life_events").getFullList({
    filter: pb.filter("log = {:logId}", { logId: log.id }),
    sort: "timestamp,id",
    $autoCancel: false,
  });
  // Prior-run children: any event with labels.view_run set. Merge them with the
  // fat sources so planSessionFanout can do per-child idempotency.
  const children = allEvents
    .filter((r) => {
      const labels = r.labels;
      return labels && typeof labels === "object" && !Array.isArray(labels) && (labels as any).view_run;
    })
    .map((r) => ({
      id: r.id as string,
      subject_id: (r.subject_id as string) || "",
      timestamp: r.timestamp as string,
      entries: Array.isArray(r.entries) ? (r.entries as any[]) : [],
      labels: r.labels as Record<string, string>,
      created_by: (r.created_by as string) || undefined,
    }));

  const sourceCount = events.length;
  totals.logs++;
  totals.sources += sourceCount;

  console.log("");
  console.log(`  Log ${log.id} (owner ${log.ownerId || "?"}, tz ${log.tz}): ${sourceCount} session source(s), ${children.length} prior child(ren)`);
  if (sourceCount === 0) {
    console.log("    nothing to do");
    continue;
  }

  const actions = planSessionFanout([...events, ...children]);
  let curSource = "";
  for (const a of actions) {
    if (a.sourceId !== curSource) {
      curSource = a.sourceId;
      console.log(`    source ${a.sourceId} (${a.subject})`);
    }
    console.log(`      ${describe(a)}`);
    if (a.kind === "create") totals.create++;
    else if (a.kind === "skip") totals.skip++;
    else if (a.kind === "delete-source") totals.deleteSource++;
    else if (a.kind === "delete-only") totals.deleteOnly++;
    else totals.error++;
  }

  if (dryRun) continue;

  // Apply. Ordering is load-bearing: create ALL children for a source FIRST,
  // delete the source LAST — a crash in between leaves a rerun-healable state
  // (existing children -> skip), never a deleted source with missing children.
  // A source with any `error` action emits NO delete-source/delete-only, so
  // its source survives and the run exits non-zero.
  for (const a of actions) {
    try {
      if (a.kind === "create") {
        await pb.collection("life_events").create(
          {
            log: log.id,
            subject_id: a.child.subjectId,
            timestamp: a.child.timestamp,
            entries: a.child.entries,
            labels: a.child.labels,
            ...(a.child.created_by ? { created_by: a.child.created_by } : {}),
          },
          { $autoCancel: false },
        );
      } else if (a.kind === "delete-source" || a.kind === "delete-only") {
        await pb.collection("life_events").delete(a.sourceId, { $autoCancel: false });
      }
      // "skip" and "error" write nothing.
    } catch (err: any) {
      totals.applyErrors++;
      console.error(`      ERROR applying ${a.kind} for source=${a.sourceId}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log("  ---------- Summary ----------");
console.log(`  Logs processed:            ${totals.logs}`);
console.log(`  session sources seen:      ${totals.sources}`);
console.log(`  children created:          ${totals.create}`);
console.log(`  children skipped (exist):  ${totals.skip}`);
console.log(`  sources deleted (fanned):  ${totals.deleteSource}`);
console.log(`  sources deleted (healed):  ${totals.deleteOnly}`);
console.log(`  unmapped entries (errors): ${totals.error}`);
if (!dryRun) console.log(`  apply errors:              ${totals.applyErrors}`);

if (dryRun) {
  console.log("");
  console.log("  Dry run: no changes written. Pass --apply to commit.");
}

// Sources left unresolved = those with unmapped entries (error actions left
// their source intact). Loud trailer + exit 2 when --apply leaves any.
const unresolved = totals.error;
if (!dryRun && unresolved > 0) {
  console.log("");
  console.log("  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.log(`  !!  APPLY FINISHED WITH ${unresolved} UNMAPPED ENTRY(IES)`);
  console.log("  !!  (their source events were left untouched — add the");
  console.log("  !!   missing names to SESSION_ID_MAP and rerun)");
  console.log("  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
}

// Errors (unmapped entries) make a dry-run exit 1 too — the plan is unsafe to
// apply as-is and the operator must fix the map first.
if (totals.applyErrors > 0) process.exit(1);
if (dryRun) process.exit(totals.error > 0 ? 1 : 0);
process.exit(unresolved > 0 ? 2 : 0);
