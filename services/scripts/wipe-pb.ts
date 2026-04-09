/**
 * Wipe all user data from PocketBase (keeps schema, wipes records).
 * Usage: source .env && npx tsx wipe-pb.ts
 */
import PocketBase from "pocketbase";

const pbUrl = process.env.PB_URL || "https://api.beta.kirkl.in";
console.log(`PB URL: ${pbUrl}`);
const password = process.env.PB_ADMIN_PASSWORD;
if (!password) { console.error("PB_ADMIN_PASSWORD not set"); process.exit(1); }

const pb = new PocketBase(pbUrl);
await pb.collection("_superusers").authWithPassword("scott.kirklin@gmail.com", password);

const dataCollections = [
  // Delete children first (cascade may handle some, but be explicit)
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
  "sharing_invites",
  "push_subscriptions",
  "users",
];

for (const col of dataCollections) {
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
      } catch (err: any) {
        // May fail due to cascade already deleting it
      }
    }
    console.log(`  ${col}: deleted ${deleted}/${records.length}`);
  } catch (err: any) {
    console.log(`  ${col}: ${err.message || err}`);
  }
}

console.log("\nDone. All user data wiped.");
process.exit(0);
