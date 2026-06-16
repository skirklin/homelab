/**
 * One-shot: re-aggregate already-written HOURLY health-counter `life_events`
 * (steps/distance/calories) into DAILY rows, then delete the hourly ones.
 *
 * Background
 * ----------
 * The health-ingest mapper (services/api/src/routes/health-ingest.ts) used to
 * write steps/distance/calories as one row PER LOCAL HOUR; it now writes one row
 * PER LOCAL DAY. The existing hourly rows (Jun 12–16, ~174 rows in prod) need
 * collapsing into daily rows whose shape is byte-identical to what the new
 * mapper produces.
 *
 *   - hourly rows: source_id `hc:<subject>:<UTC-instant>` (instant CONTAINS "T"),
 *     entries [{name:"amount",type:"number",value,unit}], labels {hwm:<ISO>}.
 *   - daily rows:  source_id `hc:<subject>:<YYYY-MM-DD>` (NO "T"), timestamp =
 *     noon of that local day in the owner's tz, same entries shape, labels {hwm}.
 *
 * What it does
 * ------------
 *   1. Find all life_events with subject_id in (steps,distance,calories) whose
 *      source_id is hourly (contains a "T"). Daily rows (no "T") are NEVER
 *      touched, nor any non-counter subject, nor anything with labels.source
 *      (manual entries).
 *   2. Group hourly rows by (log, subject, owner-tz local day). Per group:
 *      sum = Σ finalized values (rounded to the subject's precision), and
 *      maxHwm = max of the rows' labels.hwm.
 *   3. UPSERT a daily row keyed by source_id `hc:<subject>:<YYYY-MM-DD>`:
 *        - absent  → CREATE { timestamp: noon-of-day, value: sum, hwm: maxHwm }.
 *        - present → FOLD: add sum to its value, hwm = max(existing, maxHwm).
 *          (Hourly = pre-cutover, the daily row = post-cutover deltas — disjoint,
 *          so addition is correct.)
 *   4. After writing/folding the daily row, DELETE that group's hourly rows.
 *
 * Idempotent: re-running after success is a no-op (no hourly rows remain). Order
 * is write/fold-then-delete PER GROUP, and fold re-reads the current daily value
 * each run, so a crash mid-run can't double-count — a re-run only sees the still-
 * undeleted hourly rows and folds those.
 *
 * Safety: DRY-RUN by default — prints the full plan and writes nothing. Only
 * `--apply` performs writes/deletes.
 *
 * Usage
 * -----
 *   set -a; source /home/skirklin/projects/homelab/.env; set +a
 *   pnpm tsx historical/reaggregate-hourly-counters.ts [--log <id>] [--pb-url <url>] [--dry-run | --apply]
 *
 *   --log <id>   = scope to one life log (default: all logs).
 *   --pb-url     = PB base URL (default: $PB_URL or https://api.kirkl.in).
 *   --dry-run    = default; prints the plan, changes nothing.
 *   --apply      = write/delete for real.
 *
 * Exit codes: 0 = clean, 1 = bad args / apply errors.
 */
import { takeFlag, takeOpt } from "./lib/cli";
import { connectAdmin, resolveLogs } from "./lib/pb-admin";
import {
  COUNTER_CONFIG,
  COUNTER_SUBJECTS,
  type HourlyRow,
  groupHourlyRows,
  isHourlySourceId,
  planDaily,
} from "./lib/reaggregate";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const USAGE =
  "Usage: pnpm tsx historical/reaggregate-hourly-counters.ts [--log <id>] [--pb-url <url>] [--dry-run | --apply]";

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

console.log("======================================================");
console.log("  reaggregate hourly counters -> daily (steps/dist/cal)");
console.log("======================================================");
console.log(`  PB URL:     ${pbUrl}`);
console.log(`  Scope:      ${onlyLogId ? `log ${onlyLogId}` : "all life logs"}`);
console.log(`  Mode:       ${dryRun ? "DRY-RUN" : "APPLY"}`);
console.log("");

const pb = await connectAdmin(pbUrl);
const logs = await resolveLogs(pb, onlyLogId);
console.log(`  Logs to process: ${logs.length}`);

// ---------------------------------------------------------------------------
// Fetch hourly counter rows for a log.
// ---------------------------------------------------------------------------

/**
 * Fetch this log's counter life_events, returned as HourlyRow, filtered to the
 * HOURLY ones (source_id contains "T") and excluding any row carrying
 * labels.source (manual entries are never auto-aggregated). The JS SDK returns
 * JSON columns already parsed.
 */
async function fetchHourlyRows(logId: string): Promise<HourlyRow[]> {
  const subjectClause = COUNTER_SUBJECTS.map((_, i) => `subject_id = {:s${i}}`).join(" || ");
  const params: Record<string, string> = { logId };
  COUNTER_SUBJECTS.forEach((s, i) => (params[`s${i}`] = s));
  const records = await pb.collection("life_events").getFullList({
    filter: pb.filter(`log = {:logId} && (${subjectClause})`, params),
    sort: "timestamp,id",
    $autoCancel: false,
  });
  const out: HourlyRow[] = [];
  for (const r of records) {
    const subject = (r.subject_id as string) || "";
    const sourceId = (r.source_id as string) || "";
    const labels =
      r.labels && typeof r.labels === "object" && !Array.isArray(r.labels)
        ? (r.labels as Record<string, string>)
        : null;
    // Never touch manual entries, nor daily rows (source_id without a "T").
    if (labels && typeof labels.source === "string" && labels.source) continue;
    if (!isHourlySourceId(sourceId, subject)) continue;
    out.push({
      id: r.id,
      subject_id: subject,
      source_id: sourceId,
      timestamp: r.timestamp as string,
      entries: Array.isArray(r.entries) ? (r.entries as HourlyRow["entries"]) : [],
      labels,
    });
  }
  return out;
}

/** Read the current daily row for a group's source_id, or null. */
async function readDaily(logId: string, sourceId: string): Promise<{ id: string; value: number; hwm: string } | null> {
  const list = await pb.collection("life_events").getList(1, 1, {
    filter: pb.filter("log = {:log} && source_id = {:sid}", { log: logId, sid: sourceId }),
    $autoCancel: false,
  });
  const rec = list.items[0];
  if (!rec) return null;
  const entries = Array.isArray(rec.entries) ? (rec.entries as { value?: unknown }[]) : [];
  const e = entries.find((x) => typeof x.value === "number");
  const value = e && typeof e.value === "number" ? e.value : 0;
  const labels = rec.labels && typeof rec.labels === "object" && !Array.isArray(rec.labels) ? rec.labels : {};
  const hwm = typeof (labels as Record<string, string>).hwm === "string" ? (labels as Record<string, string>).hwm : "";
  return { id: rec.id, value, hwm };
}

// ---------------------------------------------------------------------------
// Plan + report + apply, per log
// ---------------------------------------------------------------------------

const totals = {
  logs: 0,
  hourlyRows: 0,
  groups: 0,
  creates: 0,
  folds: 0,
  deleted: 0,
  errors: 0,
};

for (const log of logs) {
  const rows = await fetchHourlyRows(log.id);
  totals.logs++;
  if (rows.length === 0) {
    console.log("");
    console.log(`  Log ${log.id} (owner ${log.ownerId || "?"}, tz ${log.tz}): no hourly counter rows`);
    continue;
  }
  totals.hourlyRows += rows.length;

  const groups = groupHourlyRows(rows, log.tz);
  totals.groups += groups.length;

  console.log("");
  console.log(
    `  Log ${log.id} (owner ${log.ownerId || "?"}, tz ${log.tz}): ${rows.length} hourly rows -> ${groups.length} daily groups`,
  );

  for (const group of groups) {
    const existing = await readDaily(log.id, group.sourceId);
    const plan = planDaily(group, existing ? { value: existing.value, hwm: existing.hwm } : null);
    const unit = COUNTER_CONFIG[group.subject].unit;

    console.log(
      `    ${group.subject.padEnd(8)} ${group.localDay}  ${String(group.rows.length).padStart(2)} hourly rows` +
        `  sum=${group.sum}${unit}  -> ${group.sourceId}` +
        `  ${plan.action.toUpperCase()}` +
        (plan.action === "fold" ? ` (existing ${existing!.value}${unit} + ${group.sum} = ${plan.value}${unit})` : ` value=${plan.value}${unit}`) +
        `  hwm=${plan.hwm || "(none)"}`,
    );

    if (dryRun) continue;

    try {
      // Write/fold the daily row FIRST, then delete the hourly sources. A crash
      // between the two re-runs cleanly: the next pass re-reads the (now folded)
      // daily value and only sees the still-undeleted hourly rows.
      if (plan.action === "create") {
        await pb.collection("life_events").create(
          {
            log: log.id,
            subject_id: group.subject,
            source_id: group.sourceId,
            timestamp: group.timestamp,
            created_by: log.ownerId,
            entries: [{ name: "amount", type: "number", value: plan.value, unit }],
            labels: { hwm: plan.hwm },
          },
          { $autoCancel: false },
        );
        totals.creates++;
      } else {
        await pb.collection("life_events").update(
          existing!.id,
          {
            entries: [{ name: "amount", type: "number", value: plan.value, unit }],
            labels: { hwm: plan.hwm },
          },
          { $autoCancel: false },
        );
        totals.folds++;
      }
      for (const row of group.rows) {
        await pb.collection("life_events").delete(row.id, { $autoCancel: false });
        totals.deleted++;
      }
    } catch (err: any) {
      totals.errors++;
      console.error(`      ERROR on ${group.sourceId}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log("  ---------- Summary ----------");
console.log(`  Logs processed:        ${totals.logs}`);
console.log(`  Hourly rows found:     ${totals.hourlyRows}`);
console.log(`  Daily groups:          ${totals.groups}`);
if (dryRun) {
  console.log(`  (dry-run: ${totals.groups} daily rows would be created/folded, ${totals.hourlyRows} hourly rows deleted)`);
  console.log("");
  console.log("  Dry run: no changes written. Pass --apply to commit.");
} else {
  console.log(`  Daily rows created:    ${totals.creates}`);
  console.log(`  Daily rows folded:     ${totals.folds}`);
  console.log(`  Hourly rows deleted:   ${totals.deleted}`);
  console.log(`  Apply errors:          ${totals.errors}`);
}

process.exit(totals.errors > 0 ? 1 : 0);
