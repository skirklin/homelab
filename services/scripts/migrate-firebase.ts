/**
 * Firebase/Firestore -> PocketBase migration script.
 *
 * Uses the @homelab/backend interfaces with the PocketBase admin client to
 * recreate all data. Idempotent: checks for existing records before creating.
 *
 * Usage:
 *   cd services/scripts
 *   npx tsx migrate-firebase.ts --pb-password <admin-password>
 *
 * Options:
 *   --pb-password <password>   PocketBase superuser password (required unless --dry-run)
 *   --pb-url <url>             PocketBase URL (default: https://api.beta.kirkl.in)
 *   --dry-run                  Read from Firestore, log what would be created
 *   --collection <name>        Only migrate: recipes, shopping, life, upkeep, or travel
 */

import admin from "firebase-admin";
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
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let pbPassword = "";
  let pbUrl = "https://api.beta.kirkl.in";
  let dryRun = false;
  let collection: string | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--pb-password": pbPassword = args[++i]; break;
      case "--pb-url": pbUrl = args[++i]; break;
      case "--dry-run": dryRun = true; break;
      case "--collection": collection = args[++i]; break;
    }
  }

  if (!pbPassword && !dryRun) {
    console.error("Error: --pb-password is required (or use --dry-run)");
    process.exit(1);
  }

  return { pbPassword, pbUrl, dryRun, collection };
}

// ---------------------------------------------------------------------------
// Init Firebase
// ---------------------------------------------------------------------------

admin.initializeApp({
  credential: admin.credential.cert("/home/skirklin/projects/firebase/service-account.json"),
  projectId: "recipe-box-335721",
});
const fireDb = admin.firestore();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Stats { created: number; skipped: number; errors: number }
function emptyStats(): Stats { return { created: 0, skipped: 0, errors: 0 }; }

function toIso(val: unknown): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (val && typeof (val as { toDate?: () => Date }).toDate === "function") {
    return (val as { toDate(): Date }).toDate().toISOString();
  }
  if (val instanceof Date) return val.toISOString();
  return "";
}

function toDate(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (typeof val === "string") return new Date(val);
  if (val && typeof (val as { toDate?: () => Date }).toDate === "function") {
    return (val as { toDate(): Date }).toDate();
  }
  return null;
}

function refId(val: unknown): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (val && typeof (val as { id?: string }).id === "string") return (val as { id: string }).id;
  return String(val);
}

/** Escape a PocketBase filter value (double quotes). */
function esc(val: string): string {
  return val.replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const config = parseArgs();

console.log("==============================================");
console.log("  Firebase -> PocketBase Migration");
console.log("==============================================");
console.log(`  PocketBase URL: ${config.pbUrl}`);
console.log(`  Dry run: ${config.dryRun}`);
console.log(`  Collection filter: ${config.collection || "all"}`);

// Init PocketBase admin client — used for ALL operations
const adminPb = new PocketBase(config.pbUrl);
adminPb.autoCancellation(false);

if (!config.dryRun) {
  console.log("\n  Authenticating with PocketBase...");
  await adminPb.collection("_superusers").authWithPassword("scott.kirklin@gmail.com", config.pbPassword);
  console.log("  Authenticated.");
}

// All backend interfaces share the admin client
const getPb = () => adminPb;
const recipes = new PocketBaseRecipesBackend(getPb);
const shopping = new PocketBaseShoppingBackend(getPb);
const upkeep = new PocketBaseUpkeepBackend(getPb);
const travel = new PocketBaseTravelBackend(getPb);
const life = new PocketBaseLifeBackend(getPb);
const userBackend = new PocketBaseUserBackend(getPb);

// ---------------------------------------------------------------------------
// Step 1: Build user mapping
// ---------------------------------------------------------------------------

console.log("\n=== Building User Map ===\n");

// Firebase UID -> PB user ID
const userMap = new Map<string, { pbId: string; email: string }>();

// Get existing PB users for dedup
const existingPbUsers = config.dryRun ? [] : await adminPb.collection("users").getFullList();
const emailToPbId = new Map<string, string>();
for (const u of existingPbUsers) {
  if (u.email) emailToPbId.set(u.email, u.id);
}
console.log(`  Existing PB users: ${existingPbUsers.length}`);

// Get Firebase Auth users
let nextPageToken: string | undefined;
let firebaseUserCount = 0;
do {
  const result = await admin.auth().listUsers(1000, nextPageToken);
  for (const user of result.users) {
    firebaseUserCount++;
    if (!user.email) continue;

    let pbId = emailToPbId.get(user.email);

    if (!pbId && !config.dryRun) {
      try {
        const tempPassword = `migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const created = await adminPb.collection("users").create({
          email: user.email,
          password: tempPassword,
          passwordConfirm: tempPassword,
          name: user.displayName || "",
        });
        pbId = created.id;
        emailToPbId.set(user.email, pbId);
        console.log(`  Created: ${user.email} -> ${pbId}`);
      } catch (err: any) {
        console.warn(`  Failed to create ${user.email}: ${err.message}`);
        continue;
      }
    } else if (pbId) {
      console.log(`  Exists: ${user.email} -> ${pbId}`);
    } else {
      console.log(`  Would create: ${user.email} (dry run)`);
      continue;
    }

    userMap.set(user.uid, { pbId, email: user.email });
  }
  nextPageToken = result.pageToken;
} while (nextPageToken);

console.log(`  Firebase users: ${firebaseUserCount}, mapped: ${userMap.size}`);

// Helper: resolve a list of Firebase UIDs to PB IDs
function mapOwners(firebaseUids: string[]): string[] {
  return firebaseUids.map((uid) => userMap.get(uid)?.pbId).filter(Boolean) as string[];
}

// Helper: find PB user ID for a Firebase UID, or fall back to first mapped user
function resolvePbUser(firebaseUid: string): string | null {
  return userMap.get(firebaseUid)?.pbId || null;
}

const allStats: Record<string, Stats> = {};
const shouldRun = (name: string) => !config.collection || config.collection === name;

// ID maps: Firestore doc ID -> PocketBase record ID
// Used in step 7 for slug wiring
const fireBoxIdToPbId = new Map<string, string>();
const fireListIdToPbId = new Map<string, string>();
const fireTaskListIdToPbId = new Map<string, string>();
const fireLogIdToPbId = new Map<string, string>(); // life logs
const fireTravelLogIdToPbId = new Map<string, string>();

// Cache Firebase user docs (read once, used in slug wiring)
let fireUserDocs: admin.firestore.QueryDocumentSnapshot[] | null = null;
async function getFireUserDocs() {
  if (!fireUserDocs) {
    fireUserDocs = (await fireDb.collection("users").get()).docs;
  }
  return fireUserDocs;
}

// ---------------------------------------------------------------------------
// Step 2: Migrate Recipe Boxes -> Recipes -> Events
// ---------------------------------------------------------------------------

if (shouldRun("recipes")) {
  console.log("\n=== Migrating Recipe Boxes + Recipes ===\n");
  const boxStats = emptyStats();
  const recipeStats = emptyStats();
  const eventStats = emptyStats();

  const boxes = await fireDb.collection("boxes").get();
  console.log(`  Firestore boxes: ${boxes.size}`);

  for (const boxDoc of boxes.docs) {
    const boxData = boxDoc.data();
    const boxName = boxData.data?.name || boxData.name || "Untitled";
    const owners = (boxData.owners || []).map((o: unknown) => refId(o));
    const primaryOwner = owners.find((uid: string) => userMap.has(uid));

    if (!primaryOwner) {
      console.warn(`  Skip box "${boxName}" (${boxDoc.id}): no mapped owners`);
      boxStats.skipped++;
      continue;
    }

    if (config.dryRun) {
      console.log(`  Would create box "${boxName}" for ${userMap.get(primaryOwner)!.email}`);
      boxStats.created++;
      // Still count recipes for dry-run reporting
      const recipeDocs = await fireDb.collection("boxes").doc(boxDoc.id).collection("recipes").get();
      recipeStats.created += recipeDocs.size;
      const eventDocs = await fireDb.collection("boxes").doc(boxDoc.id).collection("events").get();
      eventStats.created += eventDocs.size;
      continue;
    }

    const ownerPbId = userMap.get(primaryOwner)!.pbId;

    try {
      // Idempotency: check if box with same name already exists
      let pbBoxId: string | null = null;
      try {
        const existing = await adminPb.collection("recipe_boxes").getFirstListItem(
          `name = "${esc(boxName)}"`,
        );
        pbBoxId = existing.id;
        console.log(`  Exists: box "${boxName}" -> ${pbBoxId}`);
        boxStats.skipped++;
      } catch {
        // Not found, create it
        pbBoxId = await recipes.createBox(ownerPbId, boxName);
        console.log(`  Created: box "${boxName}" -> ${pbBoxId}`);
        boxStats.created++;
      }

      fireBoxIdToPbId.set(boxDoc.id, pbBoxId);

      // Set visibility if not private
      if (boxData.visibility && boxData.visibility !== "private") {
        await recipes.setBoxVisibility(pbBoxId, boxData.visibility);
      }

      // Add additional owners
      for (const ownerUid of owners) {
        if (ownerUid === primaryOwner) continue;
        const otherPbId = userMap.get(ownerUid)?.pbId;
        if (otherPbId) {
          const boxRecord = await adminPb.collection("recipe_boxes").getOne(pbBoxId);
          if (!boxRecord.owners?.includes(otherPbId)) {
            await adminPb.collection("recipe_boxes").update(pbBoxId, { "owners+": otherPbId });
          }
        }
      }

      // Add subscribers
      const subscribers = (boxData.subscribers || []).map((s: unknown) => refId(s));
      for (const subUid of subscribers) {
        const subPbId = userMap.get(subUid)?.pbId;
        if (subPbId) {
          await recipes.subscribeToBox(subPbId, pbBoxId);
        }
      }

      // Migrate recipes in this box
      const recipeDocs = await fireDb.collection("boxes").doc(boxDoc.id).collection("recipes").get();
      for (const recipeDoc of recipeDocs.docs) {
        const rData = recipeDoc.data();
        try {
          const recipeData = rData.data || rData;
          const recipeName = recipeData.name || "";

          // Idempotency: check if recipe with same name already exists in this box
          if (recipeName) {
            try {
              await adminPb.collection("recipes").getFirstListItem(
                `box = "${pbBoxId}" && data.name = "${esc(recipeName)}"`,
              );
              recipeStats.skipped++;
              continue; // already exists
            } catch {
              // Not found, proceed to create
            }
          }

          const recipeOwners = (rData.owners || []).map((o: unknown) => refId(o));
          const recipeOwner = recipeOwners.find((uid: string) => userMap.has(uid)) || primaryOwner;
          const recipeOwnerPbId = userMap.get(recipeOwner)?.pbId || ownerPbId;

          const recipeId = await recipes.addRecipe(pbBoxId, recipeData, recipeOwnerPbId);

          // Set visibility
          if (rData.visibility && rData.visibility !== "private") {
            await recipes.setRecipeVisibility(recipeId, rData.visibility);
          }

          // Set enrichment status
          if (rData.enrichmentStatus && rData.enrichmentStatus !== "needed") {
            await adminPb.collection("recipes").update(recipeId, {
              enrichment_status: rData.enrichmentStatus,
            });
          }

          // Set pending changes
          if (rData.pendingChanges) {
            await adminPb.collection("recipes").update(recipeId, {
              pending_changes: rData.pendingChanges,
            });
          }

          // Set step ingredients
          if (rData.stepIngredients) {
            await adminPb.collection("recipes").update(recipeId, {
              step_ingredients: rData.stepIngredients,
            });
          }

          recipeStats.created++;
        } catch (err: any) {
          console.error(`    Error migrating recipe ${recipeDoc.id}: ${err.message}`);
          recipeStats.errors++;
        }
      }

      // Migrate cooking log events
      const events = await fireDb.collection("boxes").doc(boxDoc.id).collection("events").get();
      for (const eventDoc of events.docs) {
        const eData = eventDoc.data();
        try {
          const createdBy = userMap.get(refId(eData.createdBy))?.pbId || ownerPbId;
          const subjectId = eData.subjectId || "";

          // Idempotency: check by timestamp + subject_id + created_by
          const ts = toIso(eData.timestamp);
          if (ts && subjectId) {
            try {
              await adminPb.collection("recipe_events").getFirstListItem(
                `box = "${pbBoxId}" && subject_id = "${esc(subjectId)}" && created_by = "${createdBy}" && timestamp = "${ts}"`,
              );
              eventStats.skipped++;
              continue;
            } catch {
              // Not found, create
            }
          }

          await recipes.addCookingLogEvent(pbBoxId, subjectId, createdBy, eData.data?.notes);
          eventStats.created++;
        } catch (err: any) {
          console.error(`    Error migrating event ${eventDoc.id}: ${err.message}`);
          eventStats.errors++;
        }
      }
    } catch (err: any) {
      console.error(`  Error creating box "${boxName}": ${err.message}`);
      boxStats.errors++;
    }
  }

  allStats["recipe_boxes"] = boxStats;
  allStats["recipes"] = recipeStats;
  allStats["recipe_events"] = eventStats;
}

// ---------------------------------------------------------------------------
// Step 3: Migrate Shopping Lists -> Items -> History -> Trips
// ---------------------------------------------------------------------------

if (shouldRun("shopping")) {
  console.log("\n=== Migrating Shopping Lists ===\n");
  const listStats = emptyStats();
  const itemStats = emptyStats();
  const historyStats = emptyStats();
  const tripStats = emptyStats();

  const lists = await fireDb.collection("lists").get();
  console.log(`  Firestore lists: ${lists.size}`);

  for (const listDoc of lists.docs) {
    const listData = listDoc.data();
    const listName = listData.name || "Untitled";
    const owners = (listData.owners || []).map((o: unknown) => refId(o));
    const primaryOwner = owners.find((uid: string) => userMap.has(uid));

    if (!primaryOwner) {
      console.warn(`  Skip list "${listName}" (${listDoc.id}): no mapped owners`);
      listStats.skipped++;
      continue;
    }

    if (config.dryRun) {
      console.log(`  Would create list "${listName}"`);
      listStats.created++;
      continue;
    }

    const ownerPbId = userMap.get(primaryOwner)!.pbId;

    try {
      // Idempotency: check if list with same name already exists
      let pbListId: string | null = null;
      try {
        const existing = await adminPb.collection("shopping_lists").getFirstListItem(
          `name = "${esc(listName)}"`,
        );
        pbListId = existing.id;
        console.log(`  Exists: list "${listName}" -> ${pbListId}`);
        listStats.skipped++;
      } catch {
        // Not found, create via backend interface
        pbListId = await shopping.createList(listName, ownerPbId);
        console.log(`  Created: list "${listName}" -> ${pbListId}`);
        listStats.created++;
      }

      fireListIdToPbId.set(listDoc.id, pbListId);

      // Add additional owners
      for (const ownerUid of owners) {
        if (ownerUid === primaryOwner) continue;
        const otherPbId = userMap.get(ownerUid)?.pbId;
        if (otherPbId) {
          const listRecord = await adminPb.collection("shopping_lists").getOne(pbListId);
          if (!listRecord.owners?.includes(otherPbId)) {
            await adminPb.collection("shopping_lists").update(pbListId, { "owners+": otherPbId });
          }
        }
      }

      // Set categories (direct admin call since createList doesn't support it)
      if (listData.categoryDefs && Array.isArray(listData.categoryDefs)) {
        await adminPb.collection("shopping_lists").update(pbListId, { category_defs: listData.categoryDefs });
      }

      // Migrate items
      const items = await fireDb.collection("lists").doc(listDoc.id).collection("items").get();
      for (const itemDoc of items.docs) {
        const iData = itemDoc.data();
        try {
          const ingredient = iData.ingredient || iData.name || "";
          const categoryId = iData.categoryId || "uncategorized";

          // Idempotency: check if item with same ingredient exists in this list (only unchecked)
          if (ingredient) {
            try {
              await adminPb.collection("shopping_items").getFirstListItem(
                `list = "${pbListId}" && ingredient = "${esc(ingredient)}"`,
              );
              itemStats.skipped++;
              continue;
            } catch {
              // Not found, create
            }
          }

          const addedBy = userMap.get(refId(iData.addedBy))?.pbId || ownerPbId;
          await adminPb.collection("shopping_items").create({
            list: pbListId,
            ingredient,
            note: iData.note || iData.notes || "",
            category_id: categoryId,
            checked: !!iData.checked,
            checked_by: iData.checkedBy ? (userMap.get(refId(iData.checkedBy))?.pbId || "") : "",
            checked_at: toIso(iData.checkedAt),
            added_by: addedBy,
          });
          itemStats.created++;
        } catch (err: any) {
          console.error(`    Error migrating item ${itemDoc.id}: ${err.message}`);
          itemStats.errors++;
        }
      }

      // Migrate history
      const history = await fireDb.collection("lists").doc(listDoc.id).collection("history").get();
      for (const histDoc of history.docs) {
        const hData = histDoc.data();
        try {
          const ingredient = (hData.ingredient || hData.name || histDoc.id).toLowerCase().trim();

          // Idempotency: check if history entry with same ingredient exists
          try {
            await adminPb.collection("shopping_history").getFirstListItem(
              `list = "${pbListId}" && ingredient = "${esc(ingredient)}"`,
            );
            historyStats.skipped++;
            continue;
          } catch {
            // Not found, create
          }

          await adminPb.collection("shopping_history").create({
            list: pbListId,
            ingredient,
            category_id: hData.categoryId || "uncategorized",
            last_added: toIso(hData.lastAdded) || new Date().toISOString(),
          });
          historyStats.created++;
        } catch (err: any) {
          console.error(`    Error migrating history ${histDoc.id}: ${err.message}`);
          historyStats.errors++;
        }
      }

      // Migrate trips
      const trips = await fireDb.collection("lists").doc(listDoc.id).collection("trips").get();
      for (const tripDoc of trips.docs) {
        const tData = tripDoc.data();
        try {
          const completedAt = toIso(tData.completedAt) || new Date().toISOString();

          // Idempotency: check by completed_at timestamp
          try {
            await adminPb.collection("shopping_trips").getFirstListItem(
              `list = "${pbListId}" && completed_at = "${completedAt}"`,
            );
            tripStats.skipped++;
            continue;
          } catch {
            // Not found, create
          }

          await adminPb.collection("shopping_trips").create({
            list: pbListId,
            completed_at: completedAt,
            items: (tData.items || []).map((item: any) => ({
              ingredient: item.ingredient || item.name || "",
              note: item.note || "",
              categoryId: item.categoryId || "uncategorized",
            })),
          });
          tripStats.created++;
        } catch (err: any) {
          console.error(`    Error migrating trip ${tripDoc.id}: ${err.message}`);
          tripStats.errors++;
        }
      }
    } catch (err: any) {
      console.error(`  Error creating list "${listName}": ${err.message}`);
      listStats.errors++;
    }
  }

  allStats["shopping_lists"] = listStats;
  allStats["shopping_items"] = itemStats;
  allStats["shopping_history"] = historyStats;
  allStats["shopping_trips"] = tripStats;
}

// ---------------------------------------------------------------------------
// Step 4: Migrate Life Logs -> Events
// ---------------------------------------------------------------------------

if (shouldRun("life")) {
  console.log("\n=== Migrating Life Logs ===\n");
  const logStats = emptyStats();
  const eventStats = emptyStats();

  const logs = await fireDb.collection("lifeLogs").get();
  console.log(`  Firestore life logs: ${logs.size}`);

  for (const logDoc of logs.docs) {
    const logData = logDoc.data();
    const owners = (logData.owners || []).map((o: unknown) => refId(o));
    const primaryOwner = owners.find((uid: string) => userMap.has(uid));

    if (!primaryOwner) {
      console.warn(`  Skip life log (${logDoc.id}): no mapped owners`);
      logStats.skipped++;
      continue;
    }

    if (config.dryRun) {
      console.log(`  Would create life log for ${userMap.get(primaryOwner)!.email}`);
      logStats.created++;
      continue;
    }

    const ownerPbId = userMap.get(primaryOwner)!.pbId;

    try {
      // Idempotency: getOrCreateLog checks user's life_log_id first
      const pbLog = await life.getOrCreateLog(ownerPbId);
      const pbLogId = pbLog.id;

      fireLogIdToPbId.set(logDoc.id, pbLogId);

      // Update manifest if present
      if (logData.manifest) {
        await life.updateManifest(pbLogId, logData.manifest);
      }

      console.log(`  Created/found: life log -> ${pbLogId} for ${userMap.get(primaryOwner)!.email}`);
      logStats.created++;

      // Migrate events
      const events = await fireDb.collection("lifeLogs").doc(logDoc.id).collection("events").get();
      for (const eventDoc of events.docs) {
        const eData = eventDoc.data();
        try {
          const createdBy = userMap.get(refId(eData.createdBy))?.pbId || ownerPbId;
          const timestamp = toDate(eData.timestamp);
          const subjectId = eData.subjectId || "";

          // Idempotency: check by subject_id + timestamp + created_by
          const ts = toIso(eData.timestamp);
          if (ts && subjectId) {
            try {
              await adminPb.collection("life_events").getFirstListItem(
                `log = "${pbLogId}" && subject_id = "${esc(subjectId)}" && created_by = "${createdBy}" && timestamp = "${ts}"`,
              );
              eventStats.skipped++;
              continue;
            } catch {
              // Not found, create
            }
          }

          await life.addEntry(pbLogId, subjectId, eData.data || {}, createdBy, {
            timestamp: timestamp || undefined,
            notes: eData.data?.notes,
          });
          eventStats.created++;
        } catch (err: any) {
          console.error(`    Error migrating life event ${eventDoc.id}: ${err.message}`);
          eventStats.errors++;
        }
      }
    } catch (err: any) {
      console.error(`  Error creating life log: ${err.message}`);
      logStats.errors++;
    }
  }

  allStats["life_logs"] = logStats;
  allStats["life_events"] = eventStats;
}

// ---------------------------------------------------------------------------
// Step 5: Migrate Task Lists -> Tasks -> Task Events
// ---------------------------------------------------------------------------

if (shouldRun("upkeep")) {
  console.log("\n=== Migrating Task Lists ===\n");
  const listStats = emptyStats();
  const taskStats = emptyStats();
  const eventStats = emptyStats();

  const lists = await fireDb.collection("taskLists").get();
  console.log(`  Firestore task lists: ${lists.size}`);

  for (const listDoc of lists.docs) {
    const listData = listDoc.data();
    const listName = listData.name || "Untitled";
    const owners = (listData.owners || []).map((o: unknown) => refId(o));
    const primaryOwner = owners.find((uid: string) => userMap.has(uid));

    if (!primaryOwner) {
      console.warn(`  Skip task list "${listName}" (${listDoc.id}): no mapped owners`);
      listStats.skipped++;
      continue;
    }

    if (config.dryRun) {
      console.log(`  Would create task list "${listName}"`);
      listStats.created++;
      continue;
    }

    const ownerPbId = userMap.get(primaryOwner)!.pbId;

    try {
      // Idempotency: check if task list with same name already exists
      let pbListId: string | null = null;
      try {
        const existing = await adminPb.collection("task_lists").getFirstListItem(
          `name = "${esc(listName)}"`,
        );
        pbListId = existing.id;
        console.log(`  Exists: task list "${listName}" -> ${pbListId}`);
        listStats.skipped++;
      } catch {
        // Not found, create via backend interface
        pbListId = await upkeep.createList(listName, ownerPbId);
        console.log(`  Created: task list "${listName}" -> ${pbListId}`);
        listStats.created++;
      }

      fireTaskListIdToPbId.set(listDoc.id, pbListId);

      // Add additional owners
      for (const ownerUid of owners) {
        if (ownerUid === primaryOwner) continue;
        const otherPbId = userMap.get(ownerUid)?.pbId;
        if (otherPbId) {
          const listRecord = await adminPb.collection("task_lists").getOne(pbListId);
          if (!listRecord.owners?.includes(otherPbId)) {
            await adminPb.collection("task_lists").update(pbListId, { "owners+": otherPbId });
          }
        }
      }

      // Set rooms
      if (listData.roomDefs) {
        await adminPb.collection("task_lists").update(pbListId, { room_defs: listData.roomDefs });
      }

      // Migrate tasks
      const tasks = await fireDb.collection("taskLists").doc(listDoc.id).collection("tasks").get();
      const taskIdMap = new Map<string, string>(); // Firestore task ID -> PB task ID

      for (const taskDoc of tasks.docs) {
        const tData = taskDoc.data();
        try {
          const taskName = tData.name || "";

          // Idempotency: check if task with same name exists in this list
          let pbTaskId: string | null = null;
          if (taskName) {
            try {
              const existing = await adminPb.collection("tasks").getFirstListItem(
                `list = "${pbListId}" && name = "${esc(taskName)}"`,
              );
              pbTaskId = existing.id;
              taskIdMap.set(taskDoc.id, pbTaskId);
              taskStats.skipped++;
              continue;
            } catch {
              // Not found, create
            }
          }

          // Use backend interface addTask
          const lastCompleted = toDate(tData.lastCompleted);
          pbTaskId = await upkeep.addTask(pbListId, {
            name: taskName,
            description: tData.description || "",
            roomId: tData.roomId || "",
            frequency: tData.frequency || 0,
            lastCompleted,
            snoozedUntil: toDate(tData.snoozedUntil),
            notifyUsers: (tData.notifyUsers || []).map((uid: string) => userMap.get(uid)?.pbId).filter(Boolean) as string[],
          });
          taskIdMap.set(taskDoc.id, pbTaskId);
          taskStats.created++;
        } catch (err: any) {
          console.error(`    Error migrating task ${taskDoc.id}: ${err.message}`);
          taskStats.errors++;
        }
      }

      // Migrate task events (completions)
      const events = await fireDb.collection("taskLists").doc(listDoc.id).collection("events").get();
      for (const eventDoc of events.docs) {
        const eData = eventDoc.data();
        try {
          const taskPbId = taskIdMap.get(eData.subjectId);
          if (!taskPbId) continue;
          const createdBy = userMap.get(refId(eData.createdBy))?.pbId || ownerPbId;
          const ts = toIso(eData.timestamp) || new Date().toISOString();

          // Idempotency: check by subject_id + timestamp + created_by
          try {
            await adminPb.collection("task_events").getFirstListItem(
              `list = "${pbListId}" && subject_id = "${taskPbId}" && created_by = "${createdBy}" && timestamp = "${ts}"`,
            );
            eventStats.skipped++;
            continue;
          } catch {
            // Not found, create
          }

          // Create event directly (not via completeTask which would update lastCompleted)
          await adminPb.collection("task_events").create({
            list: pbListId,
            subject_id: taskPbId,
            timestamp: ts,
            created_by: createdBy,
            data: eData.data || {},
          });
          eventStats.created++;
        } catch (err: any) {
          console.error(`    Error migrating task event ${eventDoc.id}: ${err.message}`);
          eventStats.errors++;
        }
      }
    } catch (err: any) {
      console.error(`  Error creating task list "${listName}": ${err.message}`);
      listStats.errors++;
    }
  }

  allStats["task_lists"] = listStats;
  allStats["tasks"] = taskStats;
  allStats["task_events"] = eventStats;
}

// ---------------------------------------------------------------------------
// Step 6: Migrate Travel Logs -> Trips -> Activities -> Itineraries
// ---------------------------------------------------------------------------

if (shouldRun("travel")) {
  console.log("\n=== Migrating Travel Logs ===\n");
  const logStats = emptyStats();
  const tripStats = emptyStats();
  const activityStats = emptyStats();
  const itineraryStats = emptyStats();

  const logs = await fireDb.collection("travelLogs").get();
  console.log(`  Firestore travel logs: ${logs.size}`);

  for (const logDoc of logs.docs) {
    const logData = logDoc.data();
    const owners = (logData.owners || []).map((o: unknown) => refId(o));
    const primaryOwner = owners.find((uid: string) => userMap.has(uid));

    if (!primaryOwner) {
      console.warn(`  Skip travel log (${logDoc.id}): no mapped owners`);
      logStats.skipped++;
      continue;
    }

    if (config.dryRun) {
      console.log(`  Would create travel log for ${userMap.get(primaryOwner)!.email}`);
      logStats.created++;
      continue;
    }

    const ownerPbId = userMap.get(primaryOwner)!.pbId;

    try {
      // getOrCreateLog is already idempotent (checks user's travel_slugs)
      const pbLogId = await travel.getOrCreateLog(ownerPbId);

      fireTravelLogIdToPbId.set(logDoc.id, pbLogId);

      // Add additional owners
      for (const ownerUid of owners) {
        if (ownerUid === primaryOwner) continue;
        const otherPbId = userMap.get(ownerUid)?.pbId;
        if (otherPbId) {
          const logRecord = await adminPb.collection("travel_logs").getOne(pbLogId);
          if (!logRecord.owners?.includes(otherPbId)) {
            await adminPb.collection("travel_logs").update(pbLogId, { "owners+": otherPbId });
          }
        }
      }

      // Checklists
      if (logData.checklists) {
        await travel.updateLogChecklists(pbLogId, logData.checklists);
      }

      console.log(`  Created/found: travel log -> ${pbLogId} for ${userMap.get(primaryOwner)!.email}`);
      logStats.created++;

      // Migrate trips
      const trips = await fireDb.collection("travelLogs").doc(logDoc.id).collection("trips").get();
      const tripIdMap = new Map<string, string>();

      for (const tripDoc of trips.docs) {
        const tData = tripDoc.data();
        try {
          const tripName = tData.name || tData.destination || "";

          // Idempotency: check if trip with same name exists in this log
          let pbTripId: string | null = null;
          if (tripName) {
            try {
              const existing = await adminPb.collection("travel_trips").getFirstListItem(
                `log = "${pbLogId}" && name = "${esc(tripName)}"`,
              );
              pbTripId = existing.id;
              tripIdMap.set(tripDoc.id, pbTripId);
              tripStats.skipped++;
              continue;
            } catch {
              // Not found, create
            }
          }

          pbTripId = await travel.addTrip(pbLogId, {
            name: tripName,
            destination: tData.destination || "",
            startDate: toIso(tData.startDate),
            endDate: toIso(tData.endDate),
            notes: tData.notes || "",
            flagged: !!tData.flaggedForReview,
            flagComment: tData.reviewComment || "",
            checklistDone: tData.checklistDone || {},
            status: tData.status,
            region: tData.region,
            source_refs: tData.sourceRefs,
          });
          tripIdMap.set(tripDoc.id, pbTripId);
          tripStats.created++;
        } catch (err: any) {
          console.error(`    Error migrating trip ${tripDoc.id}: ${err.message}`);
          tripStats.errors++;
        }
      }

      // Migrate activities
      const activities = await fireDb.collection("travelLogs").doc(logDoc.id).collection("activities").get();
      const activityIdMap = new Map<string, string>();

      for (const actDoc of activities.docs) {
        const aData = actDoc.data();
        try {
          const actName = aData.name || "";

          // Idempotency: check if activity with same name exists in this log
          let pbActId: string | null = null;
          if (actName) {
            try {
              const existing = await adminPb.collection("travel_activities").getFirstListItem(
                `log = "${pbLogId}" && name = "${esc(actName)}"`,
              );
              pbActId = existing.id;
              activityIdMap.set(actDoc.id, pbActId);
              activityStats.skipped++;
              continue;
            } catch {
              // Not found, create
            }
          }

          const tripPbId = tripIdMap.get(aData.tripId) || "";
          pbActId = await travel.addActivity(pbLogId, {
            name: actName,
            trip: tripPbId || undefined,
            location: aData.location || "",
            lat: aData.lat,
            lng: aData.lng,
            placeId: aData.placeId,
            notes: aData.description || aData.notes || "",
            rating: aData.rating,
            tags: aData.tags || [],
            category: aData.category,
            costNotes: aData.costNotes,
            durationEstimate: aData.durationEstimate,
            confirmationCode: aData.confirmationCode,
          } as any);
          activityIdMap.set(actDoc.id, pbActId);
          activityStats.created++;
        } catch (err: any) {
          console.error(`    Error migrating activity ${actDoc.id}: ${err.message}`);
          activityStats.errors++;
        }
      }

      // Migrate itineraries
      const itineraries = await fireDb.collection("travelLogs").doc(logDoc.id).collection("itineraries").get();
      for (const itDoc of itineraries.docs) {
        const iData = itDoc.data();
        try {
          const itName = iData.name || "Itinerary";
          const tripPbId = tripIdMap.get(iData.tripId) || "";

          // Idempotency: check if itinerary with same name + trip exists
          if (tripPbId) {
            try {
              await adminPb.collection("travel_itineraries").getFirstListItem(
                `log = "${pbLogId}" && trip_id = "${tripPbId}" && name = "${esc(itName)}"`,
              );
              itineraryStats.skipped++;
              continue;
            } catch {
              // Not found, create
            }
          }

          // Remap activity IDs in day slots
          const days = (iData.days || []).map((day: any) => ({
            ...day,
            lodgingActivityId: activityIdMap.get(day.lodgingActivityId) || day.lodgingActivityId,
            flights: (day.flights || []).map((f: any) => ({
              ...f,
              activityId: activityIdMap.get(f.activityId) || f.activityId,
            })),
            slots: (day.slots || []).map((s: any) => ({
              ...s,
              activityId: activityIdMap.get(s.activityId) || s.activityId,
            })),
          }));

          await travel.addItinerary(pbLogId, tripPbId, { name: itName, days });
          itineraryStats.created++;
        } catch (err: any) {
          console.error(`    Error migrating itinerary ${itDoc.id}: ${err.message}`);
          itineraryStats.errors++;
        }
      }
    } catch (err: any) {
      console.error(`  Error creating travel log: ${err.message}`);
      logStats.errors++;
    }
  }

  allStats["travel_logs"] = logStats;
  allStats["travel_trips"] = tripStats;
  allStats["travel_activities"] = activityStats;
  allStats["travel_itineraries"] = itineraryStats;
}

// ---------------------------------------------------------------------------
// Step 7: Update user profiles with mapped IDs (slugs, boxes, life_log_id)
// ---------------------------------------------------------------------------

if (!config.dryRun) {
  console.log("\n=== Wiring User Slugs + Profiles ===\n");

  const fireUsers = await getFireUserDocs();

  for (const userDoc of fireUsers) {
    const userData = userDoc.data();
    const mapped = userMap.get(userDoc.id);
    if (!mapped) continue;

    const { pbId, email } = mapped;

    // Shopping slugs: Firestore users/{uid}.slugs -> PB users.shopping_slugs
    const shoppingSlugs = userData.slugs || {};
    for (const [slug, fireListId] of Object.entries(shoppingSlugs)) {
      const pbListId = fireListIdToPbId.get(fireListId as string);
      if (pbListId) {
        await userBackend.setSlug(pbId, "shopping", slug, pbListId);
        console.log(`  ${email}: shopping slug "${slug}" -> ${pbListId}`);
      }
    }

    // Household slugs: Firestore users/{uid}.householdSlugs -> PB users.household_slugs
    const householdSlugs = userData.householdSlugs || {};
    for (const [slug, fireListId] of Object.entries(householdSlugs)) {
      const pbListId = fireTaskListIdToPbId.get(fireListId as string);
      if (pbListId) {
        await userBackend.setSlug(pbId, "household", slug, pbListId);
        console.log(`  ${email}: household slug "${slug}" -> ${pbListId}`);
      }
    }

    // Travel slugs: Firestore users/{uid}.travelSlugs -> PB users.travel_slugs
    const travelSlugs = userData.travelSlugs || {};
    for (const [slug, fireLogId] of Object.entries(travelSlugs)) {
      const pbLogId = fireTravelLogIdToPbId.get(fireLogId as string);
      if (pbLogId) {
        await userBackend.setSlug(pbId, "travel", slug, pbLogId);
        console.log(`  ${email}: travel slug "${slug}" -> ${pbLogId}`);
      }
    }

    // Life log ID: Firestore users/{uid}.lifeLogId -> PB users.life_log_id
    if (userData.lifeLogId) {
      const pbLogId = fireLogIdToPbId.get(userData.lifeLogId);
      if (pbLogId) {
        await adminPb.collection("users").update(pbId, { life_log_id: pbLogId });
        console.log(`  ${email}: life_log_id -> ${pbLogId}`);
      }
    }

    // Recipe boxes: Firestore users/{uid}.boxes (DocumentReference[]) -> PB users.recipe_boxes
    if (userData.boxes && Array.isArray(userData.boxes)) {
      const pbBoxIds = userData.boxes
        .map((ref: unknown) => fireBoxIdToPbId.get(refId(ref)))
        .filter(Boolean) as string[];
      if (pbBoxIds.length > 0) {
        // Merge with existing (createBox already added some)
        const userRecord = await adminPb.collection("users").getOne(pbId);
        const existing: string[] = userRecord.recipe_boxes || [];
        const merged = [...new Set([...existing, ...pbBoxIds])];
        await adminPb.collection("users").update(pbId, { recipe_boxes: merged });
        console.log(`  ${email}: recipe_boxes -> [${merged.join(", ")}]`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n==============================================");
console.log("  Migration Summary");
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
console.log("\n  Done!");

process.exit(totalErrors > 0 ? 1 : 0);
