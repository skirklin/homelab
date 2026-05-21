/**
 * Prune dangling user.recipe_boxes entries.
 *
 * users.recipe_boxes is a JSON array of box IDs (not a multi-relation), so
 * deletions of recipe_boxes rows historically left stale IDs in user
 * records. The recipes app fetches each ID per page load, producing 404s
 * for every dangling entry.
 *
 * This script:
 *   1. Auths as a superuser.
 *   2. Loads the full set of live recipe_boxes IDs.
 *   3. For each user with non-empty recipe_boxes, diffs against live IDs.
 *   4. In --apply mode, writes back the cleaned array. Default is dry-run.
 *
 * Going-forward cleanup is handled by the recipe_boxes onRecordAfterDeleteSuccess
 * hook (infra/pocketbase/pb_hooks/recipe-box-cleanup.pb.js); this script is a
 * one-shot to clean up the drift that's already accumulated.
 *
 * Usage:
 *   source .env && npx tsx prune-dangling-recipe-boxes.ts            # dry-run (default)
 *   source .env && npx tsx prune-dangling-recipe-boxes.ts --apply    # write changes
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

console.log(`PB URL: ${pbUrl}`);
console.log(`Mode: ${dryRun ? "DRY-RUN (no writes)" : "APPLY (will write changes)"}`);

const pb = new PocketBase(pbUrl);
await pb.collection("_superusers").authWithPassword("scott.kirklin@gmail.com", password);

// 1. Fetch the live set of recipe_boxes IDs.
const boxes = await pb.collection("recipe_boxes").getFullList({ $autoCancel: false, fields: "id" });
const liveBoxIds = new Set(boxes.map((b) => b.id));
console.log(`Live recipe_boxes: ${liveBoxIds.size}`);

// 2. Fetch users with non-empty recipe_boxes. The field is JSON, so PB
//    can't filter it cleanly; pull all users and filter client-side.
const allUsers = await pb.collection("users").getFullList({
  $autoCancel: false,
  fields: "id,email,recipe_boxes",
});

let usersTouched = 0;
let idsPruned = 0;

for (const user of allUsers) {
  const current = (user.recipe_boxes || []) as string[];
  if (!Array.isArray(current) || current.length === 0) continue;

  const dangling = current.filter((id) => !liveBoxIds.has(id));
  if (dangling.length === 0) continue;

  const cleaned = current.filter((id) => liveBoxIds.has(id));
  const email = (user as { email?: string }).email || "(no email)";

  console.log(`\nUser ${user.id} <${email}>:`);
  console.log(`  before (${current.length}): ${current.join(", ")}`);
  console.log(`  dangling (${dangling.length}): ${dangling.join(", ")}`);
  console.log(`  after  (${cleaned.length}): ${cleaned.join(", ") || "(empty)"}`);

  usersTouched++;
  idsPruned += dangling.length;

  if (!dryRun) {
    try {
      await pb.collection("users").update(user.id, { recipe_boxes: cleaned }, { $autoCancel: false });
      console.log(`  wrote.`);
    } catch (err: unknown) {
      console.error(`  WRITE FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
}

console.log("\n--- Summary ---");
console.log(`Users with dangling refs: ${usersTouched}`);
console.log(`Total IDs pruned:         ${idsPruned}`);
if (dryRun && usersTouched > 0) {
  console.log("\nRe-run with --apply to commit.");
}

process.exit(0);
