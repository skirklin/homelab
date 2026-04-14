/**
 * Import JSON snapshot into PocketBase using @homelab/backend interfaces.
 *
 * Usage:
 *   export $(grep -v '^#' .env | xargs)
 *   npx tsx import-to-pb.ts [--snapshot-dir <dir>] [--pb-url <url>]
 *
 * Reads from snapshots/<date>/ directory (default: latest).
 * Idempotent: skips records that already exist (matched by name/key fields).
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import PocketBase from "pocketbase";
import {
  PocketBaseRecipesBackend,
  PocketBaseShoppingBackend,
  PocketBaseUpkeepBackend,
  PocketBaseTravelBackend,
  PocketBaseLifeBackend,
  PocketBaseUserBackend,
} from "@homelab/backend/pocketbase";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const pbUrl = process.argv.includes("--pb-url")
  ? process.argv[process.argv.indexOf("--pb-url") + 1]
  : (process.env.PB_URL || "https://api.beta.kirkl.in");
const password = process.env.PB_ADMIN_PASSWORD;
if (!password) { console.error("PB_ADMIN_PASSWORD not set"); process.exit(1); }

let snapshotDir = process.argv.includes("--snapshot-dir")
  ? process.argv[process.argv.indexOf("--snapshot-dir") + 1]
  : "";

if (!snapshotDir) {
  console.error("Error: --snapshot-dir is required");
  process.exit(1);
}

console.log("==============================================");
console.log("  JSON -> PocketBase Import");
console.log("==============================================");
console.log(`  PB URL: ${pbUrl}`);
console.log(`  Snapshot: ${snapshotDir}`);

// ---------------------------------------------------------------------------
// Init PocketBase
// ---------------------------------------------------------------------------

const pb = new PocketBase(pbUrl);
pb.autoCancellation(false);
await pb.collection("_superusers").authWithPassword("scott.kirklin@gmail.com", password);
console.log("  PB auth OK\n");

const getPb = () => pb;
const recipes = new PocketBaseRecipesBackend(getPb);
const shopping = new PocketBaseShoppingBackend(getPb);
const upkeep = new PocketBaseUpkeepBackend(getPb);
const travel = new PocketBaseTravelBackend(getPb);
const life = new PocketBaseLifeBackend(getPb);
const user = new PocketBaseUserBackend(getPb);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Stats { created: number; skipped: number; errors: number }
function emptyStats(): Stats { return { created: 0, skipped: 0, errors: 0 }; }

function loadJson(filename: string): any[] {
  return JSON.parse(readFileSync(join(snapshotDir, filename), "utf-8"));
}

/** Deserialize __type markers back to plain values */
function deTs(val: unknown): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object" && (val as any).__type === "timestamp") return (val as any).value;
  return "";
}

function deRef(val: unknown): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object" && (val as any).__type === "ref") return (val as any).id;
  return "";
}

function deRefs(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map(deRef).filter(Boolean);
}

// Firebase UID → PB user ID
const uidMap = new Map<string, string>();

// Firestore doc ID → PB record ID (per collection)
const idMap: Record<string, Map<string, string>> = {};
function getMap(col: string): Map<string, string> {
  if (!idMap[col]) idMap[col] = new Map();
  return idMap[col];
}

const allStats: Record<string, Stats> = {};

// ---------------------------------------------------------------------------
// Step 1: Create users
// ---------------------------------------------------------------------------

async function importUsers() {
  console.log("=== Creating Users ===\n");
  const stats = emptyStats();
  const authUsers = loadJson("_auth_users.json");

  // Check existing PB users
  const existing = await pb.collection("users").getFullList({ $autoCancel: false });
  const emailToId = new Map(existing.map(u => [u.email, u.id]));

  for (const au of authUsers) {
    if (!au.email) continue;

    if (emailToId.has(au.email)) {
      uidMap.set(au.uid, emailToId.get(au.email)!);
      console.log(`  Exists: ${au.email} -> ${emailToId.get(au.email)}`);
      stats.skipped++;
      continue;
    }

    try {
      const tempPw = `migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const created = await pb.collection("users").create({
        email: au.email,
        password: tempPw,
        passwordConfirm: tempPw,
        name: au.displayName || "",
      }, { $autoCancel: false });
      uidMap.set(au.uid, created.id);
      emailToId.set(au.email, created.id);
      console.log(`  Created: ${au.email} -> ${created.id}`);
      stats.created++;
    } catch (err: any) {
      console.error(`  Error creating ${au.email}: ${err.message}`);
      stats.errors++;
    }
  }

  console.log(`  Mapped: ${uidMap.size} users\n`);
  allStats["users"] = stats;
}

function mapUids(uids: unknown[]): string[] {
  if (!Array.isArray(uids)) return [];
  return uids.map(u => uidMap.get(deRef(u)) || "").filter(Boolean);
}

function mapUid(uid: unknown): string {
  return uidMap.get(deRef(uid)) || "";
}

// ---------------------------------------------------------------------------
// Step 2: Recipe boxes + recipes + events
// ---------------------------------------------------------------------------

async function importRecipes() {
  console.log("=== Importing Recipe Boxes ===\n");
  const boxStats = emptyStats();
  const recipeStats = emptyStats();
  const eventStats = emptyStats();

  const boxes = loadJson("boxes.json");

  for (const box of boxes) {
    const name = box.data?.name || box.name || "Untitled";
    const owners = mapUids(box.owners || []);
    const primaryOwner = owners[0];

    if (!primaryOwner) {
      console.warn(`  Skip box "${name}": no mapped owners`);
      boxStats.skipped++;
      continue;
    }

    // Idempotency check
    try {
      const existing = await pb.collection("recipe_boxes").getFirstListItem(pb.filter("name = {:name}", { name }), { $autoCancel: false });
      getMap("recipe_boxes").set(box._id, existing.id);
      console.log(`  Exists: "${name}" -> ${existing.id}`);
      boxStats.skipped++;
    } catch {
      // Doesn't exist, create it
      try {
        const pbBoxId = await recipes.createBox(primaryOwner, name);

        // Set all owners
        if (owners.length > 1) {
          await pb.collection("recipe_boxes").update(pbBoxId, { owners }, { $autoCancel: false });
        }

        // Visibility
        if (box.visibility && box.visibility !== "private") {
          await recipes.setBoxVisibility(pbBoxId, box.visibility);
        }

        // Subscribers
        for (const subUid of (box.subscribers || []).map(deRef)) {
          const pbSubId = uidMap.get(subUid);
          if (pbSubId) await recipes.subscribeToBox(pbSubId, pbBoxId);
        }

        getMap("recipe_boxes").set(box._id, pbBoxId);
        console.log(`  Created: "${name}" -> ${pbBoxId}`);
        boxStats.created++;
      } catch (err: any) {
        console.error(`  Error: "${name}": ${err.message}`);
        boxStats.errors++;
        continue;
      }
    }

    const pbBoxId = getMap("recipe_boxes").get(box._id)!;

    // Recipes
    for (const recipe of (box._sub_recipes || [])) {
      const rName = recipe.data?.name || "Untitled Recipe";
      try {
        const existingR = await pb.collection("recipes").getFirstListItem(
          pb.filter("box = {:pbBoxId} && data.name = {:rName}", { pbBoxId, rName }), { $autoCancel: false }
        );
        getMap("recipes").set(recipe._id, existingR.id);
        recipeStats.skipped++;
      } catch {
        try {
          const rOwners = mapUids(recipe.owners || []);
          const rOwnerId = rOwners[0] || primaryOwner;
          const recipeId = await recipes.addRecipe(pbBoxId, recipe.data || {}, rOwnerId);

          // Extra fields via admin
          const updates: Record<string, unknown> = {};
          if (recipe.visibility && recipe.visibility !== "private") updates.visibility = recipe.visibility;
          if (recipe.enrichmentStatus) updates.enrichment_status = recipe.enrichmentStatus;
          if (recipe.pendingChanges) updates.pending_changes = recipe.pendingChanges;
          if (recipe.stepIngredients) updates.step_ingredients = recipe.stepIngredients;
          if (Object.keys(updates).length > 0) {
            await pb.collection("recipes").update(recipeId, updates, { $autoCancel: false });
          }

          getMap("recipes").set(recipe._id, recipeId);
          recipeStats.created++;
        } catch (err: any) {
          recipeStats.errors++;
        }
      }
    }

    // Events
    for (const event of (box._sub_events || [])) {
      try {
        const createdBy = mapUid(event.createdBy) || primaryOwner;
        // Map subjectId (old recipe ID) to new PB recipe ID
        const pbRecipeId = getMap("recipes").get(event.subjectId) || event.subjectId;
        const eventTs = deTs(event.timestamp);
          await recipes.addCookingLogEvent(pbBoxId, pbRecipeId, createdBy, {
            notes: event.data?.notes,
            timestamp: eventTs ? new Date(eventTs) : undefined,
          });
        eventStats.created++;
      } catch (err: any) {
        eventStats.errors++;
      }
    }
  }

  allStats["recipe_boxes"] = boxStats;
  allStats["recipes"] = recipeStats;
  allStats["recipe_events"] = eventStats;
}

// ---------------------------------------------------------------------------
// Step 3: Shopping
// ---------------------------------------------------------------------------

async function importShopping() {
  console.log("\n=== Importing Shopping Lists ===\n");
  const listStats = emptyStats();
  const itemStats = emptyStats();
  const historyStats = emptyStats();
  const tripStats = emptyStats();

  const lists = loadJson("lists.json");

  for (const list of lists) {
    const name = list.name || "Untitled";
    const owners = mapUids(list.owners || []);
    const primaryOwner = owners[0];
    if (!primaryOwner) { listStats.skipped++; continue; }

    let pbListId: string;
    try {
      const existing = await pb.collection("shopping_lists").getFirstListItem(pb.filter("name = {:name}", { name }), { $autoCancel: false });
      pbListId = existing.id;
      getMap("shopping_lists").set(list._id, pbListId);
      console.log(`  Exists: "${name}" -> ${pbListId}`);
      listStats.skipped++;
    } catch {
      try {
        pbListId = await shopping.createList(name, primaryOwner);
        if (owners.length > 1) {
          console.log(`    Setting owners [${owners.join(", ")}] on ${pbListId}`);
          try {
            await pb.collection("shopping_lists").update(pbListId, { owners }, { $autoCancel: false });
          } catch (ownerErr: any) {
            console.error(`    Failed to set owners: ${ownerErr.message || ownerErr}`);
          }
        }
        if (list.categoryDefs) {
          await shopping.updateCategories(pbListId, list.categoryDefs);
        }
        getMap("shopping_lists").set(list._id, pbListId);
        console.log(`  Created: "${name}" -> ${pbListId}`);
        listStats.created++;
      } catch (err: any) {
        console.error(`  Error: "${name}": ${err.message}`);
        listStats.errors++;
        continue;
      }
    }

    // Items
    for (const item of (list._sub_items || [])) {
      try {
        const addedBy = mapUid(item.addedBy) || primaryOwner;
        await shopping.addItem(pbListId, item.ingredient || item.name || "", addedBy, {
          categoryId: item.categoryId,
          note: item.note || item.notes,
        });
        itemStats.created++;
      } catch { itemStats.errors++; }
    }

    // History
    for (const h of (list._sub_history || [])) {
      try {
        await pb.collection("shopping_history").create({
          list: pbListId,
          ingredient: h.ingredient || h.name || h._id || "",
          category_id: h.categoryId || "uncategorized",
          last_added: deTs(h.lastAdded) || new Date().toISOString(),
        }, { $autoCancel: false });
        historyStats.created++;
      } catch { historyStats.errors++; }
    }

    // Trips
    for (const t of (list._sub_trips || [])) {
      try {
        await pb.collection("shopping_trips").create({
          list: pbListId,
          completed_at: deTs(t.completedAt) || new Date().toISOString(),
          items: (t.items || []).map((i: any) => ({
            ingredient: i.ingredient || i.name || "",
            note: i.note || "",
            categoryId: i.categoryId || "uncategorized",
          })),
        }, { $autoCancel: false });
        tripStats.created++;
      } catch { tripStats.errors++; }
    }
  }

  allStats["shopping_lists"] = listStats;
  allStats["shopping_items"] = itemStats;
  allStats["shopping_history"] = historyStats;
  allStats["shopping_trips"] = tripStats;
}

// ---------------------------------------------------------------------------
// Step 4: Life
// ---------------------------------------------------------------------------

async function importLife() {
  console.log("\n=== Importing Life Logs ===\n");
  const logStats = emptyStats();
  const eventStats = emptyStats();

  const logs = loadJson("lifeLogs.json");

  for (const log of logs) {
    const owners = mapUids(log.owners || []);
    const primaryOwner = owners[0];
    if (!primaryOwner) { logStats.skipped++; continue; }

    try {
      const pbLog = await life.getOrCreateLog(primaryOwner);
      const pbLogId = pbLog.id;
      getMap("life_logs").set(log._id, pbLogId);

      if (log.manifest) await life.updateManifest(pbLogId, log.manifest);

      console.log(`  Log for ${uidMap.get(deRefs(log.owners)[0]) || "?"} -> ${pbLogId}`);
      logStats.created++;

      for (const event of (log._sub_events || [])) {
        try {
          const createdBy = mapUid(event.createdBy) || primaryOwner;
          const ts = deTs(event.timestamp);
          await life.addEntry(pbLogId, event.subjectId || "", event.data || {}, createdBy, {
            timestamp: ts ? new Date(ts) : undefined,
            notes: event.data?.notes,
          });
          eventStats.created++;
        } catch { eventStats.errors++; }
      }
    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
      logStats.errors++;
    }
  }

  allStats["life_logs"] = logStats;
  allStats["life_events"] = eventStats;
}

// ---------------------------------------------------------------------------
// Step 5: Upkeep
// ---------------------------------------------------------------------------

async function importUpkeep() {
  console.log("\n=== Importing Task Lists ===\n");
  const listStats = emptyStats();
  const taskStats = emptyStats();
  const eventStats = emptyStats();

  const lists = loadJson("taskLists.json");

  for (const list of lists) {
    const name = list.name || "Untitled";
    const owners = mapUids(list.owners || []);
    const primaryOwner = owners[0];
    if (!primaryOwner) { listStats.skipped++; continue; }

    let pbListId: string;
    try {
      const existing = await pb.collection("task_lists").getFirstListItem(pb.filter("name = {:name}", { name }), { $autoCancel: false });
      pbListId = existing.id;
      getMap("task_lists").set(list._id, pbListId);
      console.log(`  Exists: "${name}" -> ${pbListId}`);
      listStats.skipped++;
    } catch {
      try {
        pbListId = await upkeep.createList(name, primaryOwner);
        if (owners.length > 1) {
          console.log(`    Setting owners [${owners.join(", ")}] on ${pbListId}`);
          try {
            await pb.collection("task_lists").update(pbListId, { owners }, { $autoCancel: false });
          } catch (ownerErr: any) {
            console.error(`    Failed to set owners: ${ownerErr.message || ownerErr}`);
          }
        }
        if (list.roomDefs) await upkeep.updateRooms(pbListId, list.roomDefs);
        getMap("task_lists").set(list._id, pbListId);
        console.log(`  Created: "${name}" -> ${pbListId}`);
        listStats.created++;
      } catch (err: any) {
        console.error(`  Error: "${name}": ${err.message}`);
        listStats.errors++;
        continue;
      }
    }

    // Tasks
    const taskIdMap = new Map<string, string>();
    for (const task of (list._sub_tasks || [])) {
      try {
        const pbTaskId = await upkeep.addTask(pbListId, {
          name: task.name || "",
          description: task.description || "",
          roomId: task.roomId || "",
          frequency: task.frequency || 0,
          lastCompleted: deTs(task.lastCompleted) ? new Date(deTs(task.lastCompleted)) : null,
          snoozedUntil: deTs(task.snoozedUntil) ? new Date(deTs(task.snoozedUntil)) : null,
          notifyUsers: mapUids(task.notifyUsers || []),
        });
        taskIdMap.set(task._id, pbTaskId);
        taskStats.created++;
      } catch { taskStats.errors++; }
    }

    // Task events (completions)
    for (const event of (list._sub_events || [])) {
      try {
        const taskPbId = taskIdMap.get(event.subjectId);
        if (!taskPbId) continue;
        const createdBy = mapUid(event.createdBy) || primaryOwner;
        await pb.collection("task_events").create({
          list: pbListId,
          subject_id: taskPbId,
          timestamp: deTs(event.timestamp) || new Date().toISOString(),
          created_by: createdBy,
          data: event.data || {},
        }, { $autoCancel: false });
        eventStats.created++;
      } catch { eventStats.errors++; }
    }
  }

  allStats["task_lists"] = listStats;
  allStats["tasks"] = taskStats;
  allStats["task_events"] = eventStats;
}

// ---------------------------------------------------------------------------
// Step 6: Travel
// ---------------------------------------------------------------------------

async function importTravel() {
  console.log("\n=== Importing Travel Logs ===\n");
  const logStats = emptyStats();
  const tripStats = emptyStats();
  const activityStats = emptyStats();
  const itineraryStats = emptyStats();

  const logs = loadJson("travelLogs.json");

  for (const log of logs) {
    const owners = mapUids(log.owners || []);
    const primaryOwner = owners[0];
    if (!primaryOwner) { logStats.skipped++; continue; }

    try {
      const pbLogId = await travel.getOrCreateLog(primaryOwner);
      getMap("travel_logs").set(log._id, pbLogId);

      if (owners.length > 1) {
        await pb.collection("travel_logs").update(pbLogId, { owners }, { $autoCancel: false });
      }
      if (log.checklists) await travel.updateLogChecklists(pbLogId, log.checklists);

      console.log(`  Travel log -> ${pbLogId}`);
      logStats.created++;

      // Trips
      const tripIdMap = new Map<string, string>();
      for (const trip of (log._sub_trips || [])) {
        try {
          const pbTripId = await travel.addTrip(pbLogId, {
            name: trip.name || trip.destination || "",
            destination: trip.destination || "",
            startDate: deTs(trip.startDate),
            endDate: deTs(trip.endDate),
            notes: trip.notes || "",
            flagged: !!trip.flaggedForReview,
            flagComment: trip.reviewComment || "",
            checklistDone: trip.checklistDone || {},
            status: trip.status,
            region: trip.region,
            sourceRefs: trip.sourceRefs,
          } as any);
          tripIdMap.set(trip._id, pbTripId);
          tripStats.created++;
        } catch { tripStats.errors++; }
      }

      // Activities
      const activityIdMap = new Map<string, string>();
      for (const act of (log._sub_activities || [])) {
        try {
          const tripPbId = tripIdMap.get(act.tripId) || "";
          const pbActId = await travel.addActivity(pbLogId, {
            name: act.name || "",
            trip: tripPbId || undefined,
            location: act.location || "",
            lat: act.lat,
            lng: act.lng,
            placeId: act.placeId,
            description: act.description || act.notes || "",
            rating: act.rating,
            tags: act.tags || [],
            category: act.category,
            costNotes: act.costNotes,
            durationEstimate: act.durationEstimate,
            confirmationCode: act.confirmationCode,
          } as any);
          activityIdMap.set(act._id, pbActId);
          activityStats.created++;
        } catch { activityStats.errors++; }
      }

      // Itineraries (remap activity IDs in day slots)
      for (const it of (log._sub_itineraries || [])) {
        try {
          const tripPbId = tripIdMap.get(it.tripId) || "";
          const days = (it.days || []).map((day: any) => ({
            ...day,
            lodgingActivityId: activityIdMap.get(day.lodgingActivityId) || day.lodgingActivityId,
            flights: (day.flights || []).map((f: any) => ({
              ...f, activityId: activityIdMap.get(f.activityId) || f.activityId,
            })),
            slots: (day.slots || []).map((s: any) => ({
              ...s, activityId: activityIdMap.get(s.activityId) || s.activityId,
            })),
          }));
          await travel.addItinerary(pbLogId, tripPbId, { name: it.name || "Itinerary", days });
          itineraryStats.created++;
        } catch { itineraryStats.errors++; }
      }
    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
      logStats.errors++;
    }
  }

  allStats["travel_logs"] = logStats;
  allStats["travel_trips"] = tripStats;
  allStats["travel_activities"] = activityStats;
  allStats["travel_itineraries"] = itineraryStats;
}

// ---------------------------------------------------------------------------
// Step 7: Wire user profiles
// ---------------------------------------------------------------------------

async function wireUserProfiles() {
  console.log("\n=== Wiring User Profiles ===\n");
  const firestoreUsers = loadJson("users.json");

  for (const fu of firestoreUsers) {
    const pbId = uidMap.get(fu._id);
    if (!pbId) continue;

    const update: Record<string, unknown> = {};

    // Shopping slugs
    if (fu.slugs) {
      const mapped: Record<string, string> = {};
      for (const [slug, fireId] of Object.entries(fu.slugs)) {
        const pbListId = getMap("shopping_lists").get(fireId as string);
        if (pbListId) mapped[slug] = pbListId;
      }
      if (Object.keys(mapped).length > 0) update.shopping_slugs = mapped;
    }

    // Household slugs
    if (fu.householdSlugs) {
      const mapped: Record<string, string> = {};
      for (const [slug, fireId] of Object.entries(fu.householdSlugs)) {
        const pbListId = getMap("task_lists").get(fireId as string);
        if (pbListId) mapped[slug] = pbListId;
      }
      if (Object.keys(mapped).length > 0) update.household_slugs = mapped;
    }

    // Travel slugs
    if (fu.travelSlugs) {
      const mapped: Record<string, string> = {};
      for (const [slug, fireId] of Object.entries(fu.travelSlugs)) {
        const pbLogId = getMap("travel_logs").get(fireId as string);
        if (pbLogId) mapped[slug] = pbLogId;
      }
      if (Object.keys(mapped).length > 0) update.travel_slugs = mapped;
    }

    // Life log
    if (fu.lifeLogId) {
      const pbLogId = getMap("life_logs").get(fu.lifeLogId);
      if (pbLogId) update.life_log_id = pbLogId;
    }

    // Recipe boxes
    if (fu.boxes) {
      const mapped = deRefs(fu.boxes).map(fireId => getMap("recipe_boxes").get(fireId)).filter(Boolean) as string[];
      if (mapped.length > 0) update.recipe_boxes = mapped;
    }

    if (Object.keys(update).length > 0) {
      try {
        await pb.collection("users").update(pbId, update, { $autoCancel: false });
        const email = [...uidMap.entries()].find(([, v]) => v === pbId)?.[0] || pbId;
        console.log(`  Updated: ${email} (${Object.keys(update).join(", ")})`);
      } catch (err: any) {
        console.error(`  Error updating ${pbId}: ${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await importUsers();
await importRecipes();
await importShopping();
await importLife();
await importUpkeep();
await importTravel();
await wireUserProfiles();

// Summary
console.log("\n==============================================");
console.log("  Import Summary");
console.log("==============================================\n");
let totalCreated = 0, totalSkipped = 0, totalErrors = 0;
for (const [name, stats] of Object.entries(allStats)) {
  console.log(`  ${name.padEnd(22)} created: ${String(stats.created).padStart(5)}  skipped: ${String(stats.skipped).padStart(5)}  errors: ${String(stats.errors).padStart(5)}`);
  totalCreated += stats.created;
  totalSkipped += stats.skipped;
  totalErrors += stats.errors;
}
console.log("  " + "-".repeat(62));
console.log(`  ${"TOTAL".padEnd(22)} created: ${String(totalCreated).padStart(5)}  skipped: ${String(totalSkipped).padStart(5)}  errors: ${String(totalErrors).padStart(5)}`);

process.exit(totalErrors > 0 ? 1 : 0);
