/**
 * Wipe user data from PocketBase (keeps schema, wipes records).
 *
 * Usage:
 *   source .env && npx tsx wipe-pb.ts                # wipe everything (except users)
 *   source .env && npx tsx wipe-pb.ts --keep travel  # keep all travel_* collections
 *   source .env && npx tsx wipe-pb.ts --only recipes # only wipe recipe_* collections
 *   source .env && npx tsx wipe-pb.ts --keep-users   # also drop users (default: keep)
 *
 * Keep/only accept comma-separated domain prefixes: recipes, shopping, life,
 * tasks, travel. Also accepts individual collection names.
 *
 * By default users, sharing_invites, push_subscriptions, and api_tokens
 * are preserved (they span domains).
 */
import PocketBase from "pocketbase";

const domain = process.env.DOMAIN || "kirkl.in";
const pbUrl = process.env.PB_URL || `https://api.${domain}`;
console.log(`PB URL: ${pbUrl}`);
const password = process.env.PB_ADMIN_PASSWORD;
if (!password) { console.error("PB_ADMIN_PASSWORD not set"); process.exit(1); }

const args = process.argv.slice(2);
function flagValue(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const keepArg = flagValue("keep");
const onlyArg = flagValue("only");
const dropUsers = args.includes("--drop-users");

// Deepest children first to minimize cascade surprises.
const allCollections = [
  "recipe_events",
  "recipes",
  "recipe_boxes",
  "shopping_items",
  "shopping_history",
  "shopping_trips",
  "shopping_lists",
  "life_events",
  "life_logs",
  "task_events",
  "tasks",
  "task_lists",
  "travel_itineraries",
  "travel_activities",
  "travel_trips",
  "travel_logs",
];

// Always keep these unless --drop-users
const crossDomain = ["sharing_invites", "push_subscriptions", "api_tokens", "users"];

function matchesPrefix(col: string, prefix: string): boolean {
  // Domain → exact collections that belong to this domain
  const domainMap: Record<string, string[]> = {
    recipes: ["recipes", "recipe_boxes", "recipe_events"],
    shopping: ["shopping_lists", "shopping_items", "shopping_history", "shopping_trips"],
    life: ["life_logs", "life_events"],
    tasks: ["tasks", "task_lists", "task_events"],
    upkeep: ["tasks", "task_lists", "task_events"],
    travel: ["travel_logs", "travel_trips", "travel_activities", "travel_itineraries"],
  };
  const cols = domainMap[prefix];
  if (cols) return cols.includes(col);
  return col === prefix;
}

function shouldWipe(col: string): boolean {
  if (crossDomain.includes(col)) return dropUsers;
  if (onlyArg) {
    const onlyList = onlyArg.split(",").map((s) => s.trim());
    return onlyList.some((p) => matchesPrefix(col, p));
  }
  if (keepArg) {
    const keepList = keepArg.split(",").map((s) => s.trim());
    return !keepList.some((p) => matchesPrefix(col, p));
  }
  return true;
}

const toWipe = [...allCollections, ...(dropUsers ? crossDomain : [])].filter(shouldWipe);

if (toWipe.length === 0) {
  console.error("No collections would be wiped. Check --keep/--only flags.");
  process.exit(1);
}

console.log(`Will wipe: ${toWipe.join(", ")}`);
if (!dropUsers) console.log(`Keeping (cross-domain): ${crossDomain.join(", ")}`);

const pb = new PocketBase(pbUrl);
await pb.collection("_superusers").authWithPassword("scott.kirklin@gmail.com", password);

for (const col of toWipe) {
  try {
    const records = await pb.collection(col).getFullList({ $autoCancel: false });
    if (records.length === 0) {
      console.log(`  ${col}: empty`);
      continue;
    }
    let deleted = 0;
    for (const r of records) {
      try {
        await pb.collection(col).delete(r.id, { $autoCancel: false });
        deleted++;
      } catch {
        // May fail due to cascade already deleting it
      }
    }
    console.log(`  ${col}: deleted ${deleted}/${records.length}`);
  } catch (err: unknown) {
    console.log(`  ${col}: ${err instanceof Error ? err.message : err}`);
  }
}

console.log("\nDone.");
process.exit(0);
