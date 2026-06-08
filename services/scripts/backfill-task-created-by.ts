/**
 * Backfill tasks.created_by for the notify_users cascade.
 *
 * The deadline-reminder cascade (services/api/src/lib/notifications/deadlines.ts)
 * floors a task's notification recipients on its `created_by`. Tasks created
 * before that change have an empty `created_by`, so they fall back to notifying
 * every list owner — the original "trip TODO pings both of us" bug.
 *
 * This one-shot sets created_by = <target user> on every task whose creator is
 * currently empty, so legacy tasks notify just that person. Tasks that already
 * name a creator are LEFT ALONE and reported (so we never silently reassign a
 * task someone else deliberately created).
 *
 * Usage:
 *   source .env && npx tsx backfill-task-created-by.ts                       # dry-run
 *   source .env && npx tsx backfill-task-created-by.ts --apply               # write
 *   source .env && npx tsx backfill-task-created-by.ts --apply --email a@b.c  # target a different user (default: scott)
 */
import PocketBase from "pocketbase";

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
const emailFlagIdx = args.indexOf("--email");
const targetEmail = emailFlagIdx >= 0 ? args[emailFlagIdx + 1] : "scott.kirklin@gmail.com";

console.log(`PB URL: ${pbUrl}`);
console.log(`Target creator: ${targetEmail}`);
console.log(`Mode: ${dryRun ? "DRY-RUN (no writes)" : "APPLY (will write changes)"}`);

const pb = new PocketBase(pbUrl);
await pb.collection("_superusers").authWithPassword("scott.kirklin@gmail.com", password);

// Resolve the target user id.
const target = await pb
  .collection("users")
  .getFirstListItem(pb.filter("email = {:email}", { email: targetEmail }), { $autoCancel: false });
console.log(`Target user id: ${target.id}`);

// Pull every task; created_by is a single relation ("" when unset). PB relation
// filtering on "" is unreliable across versions, so partition client-side.
const tasks = await pb.collection("tasks").getFullList({
  $autoCancel: false,
  fields: "id,name,created_by,list,task_type,deadline,completed,cleared",
});
console.log(`Total tasks: ${tasks.length}`);

const empty = tasks.filter((t) => !t.created_by);
const mine = tasks.filter((t) => t.created_by === target.id);
const other = tasks.filter((t) => t.created_by && t.created_by !== target.id);

// Of the empty ones, how many could actually fire a wrong notification today
// (one-shot, has a deadline, not done/cleared)? Purely informational.
const liveDeadline = empty.filter(
  (t) => t.task_type === "one_shot" && t.deadline && !t.completed && !t.cleared,
);

console.log(`\n--- Partition ---`);
console.log(`  empty created_by      : ${empty.length}  (will be backfilled)`);
console.log(`    └─ live one-shot+deadline: ${liveDeadline.length}  (the ones the cron acts on now)`);
console.log(`  already ${targetEmail}: ${mine.length}  (left as-is)`);
console.log(`  created by someone else: ${other.length}  (left as-is — NOT reassigned)`);

if (other.length > 0) {
  // Group the "other" tasks by creator so the operator can decide whether they
  // also want those reassigned (a separate, deliberate call).
  const byCreator = new Map<string, number>();
  for (const t of other) byCreator.set(t.created_by as string, (byCreator.get(t.created_by as string) || 0) + 1);
  console.log(`\n  tasks attributed to other creators (review before reassigning):`);
  for (const [creator, count] of byCreator) console.log(`    ${creator}: ${count}`);
}

if (empty.length === 0) {
  console.log(`\nNothing to backfill.`);
  process.exit(0);
}

let written = 0;
let failed = 0;
for (const t of empty) {
  if (dryRun) continue;
  try {
    await pb.collection("tasks").update(t.id, { created_by: target.id }, { $autoCancel: false });
    written++;
  } catch (err: unknown) {
    failed++;
    console.error(`  WRITE FAILED ${t.id} (${t.name}): ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`\n--- Summary ---`);
console.log(`  empty tasks: ${empty.length}`);
if (dryRun) {
  console.log(`  (dry-run — re-run with --apply to write)`);
} else {
  console.log(`  written: ${written}  failed: ${failed}`);
}

process.exit(0);
