/**
 * Backfill tasks.assignees = [created_by] for existing tasks.
 *
 * Phase A of the assignee feature (TASK-MODEL-DESIGN.md) renamed
 * tasks.notify_users → tasks.assignees and made `assignees` the SOLE
 * notification driver. The schema rename (migration
 * 20260608_192500_tasks_rename_notify_users_to_assignees.js) carries values
 * over, but every existing task had an EMPTY notify_users, so post-rename every
 * task has an empty `assignees`. New tasks default assignees = [created_by] at
 * create time; this one-shot does the same for the existing rows.
 *
 * For every task with an EMPTY `assignees` and a NON-EMPTY `created_by`, set
 * assignees = [created_by]. Tasks that already name assignees are LEFT ALONE
 * (we never overwrite a deliberate set), and tasks with no created_by are
 * skipped (nothing to seed from — the cascade still floors them on
 * created_by/list.owners at notify time).
 *
 * Idempotent: re-running only touches still-empty rows.
 *
 * Usage:
 *   source .env && npx tsx backfill-task-assignees.ts            # dry-run
 *   source .env && npx tsx backfill-task-assignees.ts --apply    # write
 */
import PocketBase, { type RecordModel } from "pocketbase";

const domain = process.env.DOMAIN || "kirkl.in";
const pbUrl = process.env.PB_URL || `https://api.${domain}`;
const password = process.env.PB_ADMIN_PASSWORD;
if (!password) {
  console.error("PB_ADMIN_PASSWORD not set");
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply || args.includes("--dry-run");

console.log(`PB URL: ${pbUrl}`);
console.log(`Mode: ${dryRun ? "DRY-RUN (no writes)" : "APPLY (will write changes)"}`);

const pb = new PocketBase(pbUrl);
await pb.collection("_superusers").authWithPassword("scott.kirklin@gmail.com", password);

const tasks = await pb.collection("tasks").getFullList({
  $autoCancel: false,
  fields: "id,name,assignees,created_by",
});
console.log(`Total tasks: ${tasks.length}`);

const hasAssignees = (t: RecordModel) =>
  Array.isArray(t.assignees) && t.assignees.length > 0;

const toSeed = tasks.filter((t) => !hasAssignees(t) && t.created_by);
const alreadySet = tasks.filter((t) => hasAssignees(t));
const noCreator = tasks.filter((t) => !hasAssignees(t) && !t.created_by);

console.log(`\n--- Partition ---`);
console.log(`  empty assignees + has created_by : ${toSeed.length}  (will be backfilled to [created_by])`);
console.log(`  already has assignees            : ${alreadySet.length}  (left as-is)`);
console.log(`  empty assignees + no created_by  : ${noCreator.length}  (skipped — nothing to seed)`);

if (toSeed.length === 0) {
  console.log(`\nNothing to backfill.`);
  process.exit(0);
}

let written = 0;
let failed = 0;
for (const t of toSeed) {
  if (dryRun) continue;
  try {
    await pb.collection("tasks").update(t.id, { assignees: [t.created_by] }, { $autoCancel: false });
    written++;
  } catch (err: unknown) {
    failed++;
    console.error(`  WRITE FAILED ${t.id} (${t.name}): ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`\n--- Summary ---`);
console.log(`  candidates: ${toSeed.length}`);
if (dryRun) {
  console.log(`  (dry-run — re-run with --apply to write)`);
} else {
  console.log(`  written: ${written}  failed: ${failed}`);
}

process.exit(0);
