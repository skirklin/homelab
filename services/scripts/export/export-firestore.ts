/**
 * Firestore data export script.
 * Reads all Firestore collections and writes JSON files to ./data/
 * matching PocketBase's schema for straightforward import.
 *
 * Run with: npx tsx export/export-firestore.ts
 * Requires: gcloud auth application-default login (or GOOGLE_APPLICATION_CREDENTIALS)
 */

import * as admin from "firebase-admin";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

admin.initializeApp({
  projectId: "recipe-box-335721",
});

const db = admin.firestore();

// --- Helpers ---

function toISOOrNull(
  value: admin.firestore.Timestamp | undefined | null
): string | null {
  if (!value) return null;
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return null;
}

function resolveRef(
  value: admin.firestore.DocumentReference | string | undefined | null
): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.id === "string") return value.id;
  return null;
}

function resolveRefArray(
  values: Array<admin.firestore.DocumentReference | string> | undefined | null
): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((v) => resolveRef(v)).filter((v): v is string => v !== null);
}

function writeJSON(filename: string, data: unknown[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const filepath = join(DATA_DIR, filename);
  writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

// --- Exporters ---

async function exportUsers(): Promise<number> {
  const snapshot = await db.collection("users").get();
  const records = snapshot.docs.map((doc) => {
    const d = doc.data();
    return omitUndefined({
      _firestore_id: doc.id,
      email: d.email ?? null,
      name: d.name ?? null,
      shopping_slugs: d.slugs ?? null,
      household_slugs: d.householdSlugs ?? null,
      travel_slugs: d.travelSlugs ?? null,
      life_log_id: d.lifeLogId ?? null,
      recipe_boxes: resolveRefArray(d.boxes),
      cooking_mode_seen: d.cookingModeSeen ?? null,
      last_seen_update_version: d.lastSeenUpdateVersion ?? null,
      fcm_tokens: d.fcmTokens ?? null,
      upkeep_notification_mode: d.upkeepNotificationMode ?? null,
      last_task_notification: toISOOrNull(d.lastTaskNotification),
    });
  });
  writeJSON("users.json", records);
  return records.length;
}

async function exportShoppingLists(): Promise<number> {
  const snapshot = await db.collection("lists").get();
  const records = snapshot.docs.map((doc) => {
    const d = doc.data();
    return omitUndefined({
      _firestore_id: doc.id,
      name: d.name ?? null,
      owners: d.owners ?? [],
      category_defs: d.categoryDefs ?? null,
    });
  });
  writeJSON("shopping_lists.json", records);
  return records.length;
}

async function exportShoppingItems(): Promise<number> {
  const listsSnapshot = await db.collection("lists").get();
  const records: Record<string, unknown>[] = [];

  for (const listDoc of listsSnapshot.docs) {
    const itemsSnapshot = await db
      .collection("lists")
      .doc(listDoc.id)
      .collection("items")
      .get();

    for (const itemDoc of itemsSnapshot.docs) {
      const d = itemDoc.data();
      records.push(
        omitUndefined({
          _firestore_id: itemDoc.id,
          _list_firestore_id: listDoc.id,
          ingredient: d.ingredient ?? null,
          note: d.note ?? null,
          category_id: d.categoryId ?? null,
          checked: d.checked ?? false,
          added_by: d.addedBy ?? null,
        })
      );
    }
  }

  writeJSON("shopping_items.json", records);
  return records.length;
}

async function exportShoppingHistory(): Promise<number> {
  const listsSnapshot = await db.collection("lists").get();
  const records: Record<string, unknown>[] = [];

  for (const listDoc of listsSnapshot.docs) {
    const histSnapshot = await db
      .collection("lists")
      .doc(listDoc.id)
      .collection("history")
      .get();

    for (const histDoc of histSnapshot.docs) {
      const d = histDoc.data();
      records.push(
        omitUndefined({
          _firestore_id: histDoc.id,
          _list_firestore_id: listDoc.id,
          ingredient: d.ingredient ?? null,
          category_id: d.categoryId ?? null,
          last_added: toISOOrNull(d.lastAdded),
        })
      );
    }
  }

  writeJSON("shopping_history.json", records);
  return records.length;
}

async function exportShoppingTrips(): Promise<number> {
  const listsSnapshot = await db.collection("lists").get();
  const records: Record<string, unknown>[] = [];

  for (const listDoc of listsSnapshot.docs) {
    const tripsSnapshot = await db
      .collection("lists")
      .doc(listDoc.id)
      .collection("trips")
      .get();

    for (const tripDoc of tripsSnapshot.docs) {
      const d = tripDoc.data();
      records.push(
        omitUndefined({
          _firestore_id: tripDoc.id,
          _list_firestore_id: listDoc.id,
          completed_at: toISOOrNull(d.completedAt),
          items: d.items ?? null,
        })
      );
    }
  }

  writeJSON("shopping_trips.json", records);
  return records.length;
}

async function exportRecipeBoxes(): Promise<number> {
  const snapshot = await db.collection("boxes").get();
  const records = snapshot.docs.map((doc) => {
    const d = doc.data();
    return omitUndefined({
      _firestore_id: doc.id,
      name: d.name ?? null,
      description: d.description ?? null,
      owners: d.owners ?? [],
      subscribers: d.subscribers ?? [],
      visibility: d.visibility ?? null,
      creator: resolveRef(d.creator),
      last_updated_by: resolveRef(d.lastUpdatedBy),
    });
  });
  writeJSON("recipe_boxes.json", records);
  return records.length;
}

async function exportRecipes(): Promise<number> {
  const boxesSnapshot = await db.collection("boxes").get();
  const records: Record<string, unknown>[] = [];

  for (const boxDoc of boxesSnapshot.docs) {
    const recipesSnapshot = await db
      .collection("boxes")
      .doc(boxDoc.id)
      .collection("recipes")
      .get();

    for (const recipeDoc of recipesSnapshot.docs) {
      const d = recipeDoc.data();
      records.push(
        omitUndefined({
          _firestore_id: recipeDoc.id,
          _box_firestore_id: boxDoc.id,
          data: d.data ?? null,
          owners: d.owners ?? [],
          visibility: d.visibility ?? null,
          creator: resolveRef(d.creator),
          last_updated_by: resolveRef(d.lastUpdatedBy),
          enrichment_status: d.enrichmentStatus ?? null,
          pending_changes: d.pendingChanges ?? null,
          step_ingredients: d.stepIngredients ?? null,
          cooking_log: d.cookingLog ?? null,
        })
      );
    }
  }

  writeJSON("recipes.json", records);
  return records.length;
}

async function exportRecipeEvents(): Promise<number> {
  const boxesSnapshot = await db.collection("boxes").get();
  const records: Record<string, unknown>[] = [];

  for (const boxDoc of boxesSnapshot.docs) {
    const eventsSnapshot = await db
      .collection("boxes")
      .doc(boxDoc.id)
      .collection("events")
      .get();

    for (const eventDoc of eventsSnapshot.docs) {
      const d = eventDoc.data();
      records.push(
        omitUndefined({
          _firestore_id: eventDoc.id,
          _box_firestore_id: boxDoc.id,
          subject_id: d.subjectId ?? null,
          timestamp: toISOOrNull(d.timestamp),
          created_by: resolveRef(d.createdBy),
          data: d.data ?? null,
        })
      );
    }
  }

  writeJSON("recipe_events.json", records);
  return records.length;
}

async function exportLifeLogs(): Promise<number> {
  const snapshot = await db.collection("lifeLogs").get();
  const records = snapshot.docs.map((doc) => {
    const d = doc.data();
    return omitUndefined({
      _firestore_id: doc.id,
      name: d.name ?? null,
      owners: d.owners ?? [],
      manifest: d.manifest ?? null,
      sample_schedule: d.sampleSchedule ?? null,
    });
  });
  writeJSON("life_logs.json", records);
  return records.length;
}

async function exportLifeEvents(): Promise<number> {
  const logsSnapshot = await db.collection("lifeLogs").get();
  const records: Record<string, unknown>[] = [];

  for (const logDoc of logsSnapshot.docs) {
    const eventsSnapshot = await db
      .collection("lifeLogs")
      .doc(logDoc.id)
      .collection("events")
      .get();

    for (const eventDoc of eventsSnapshot.docs) {
      const d = eventDoc.data();
      records.push(
        omitUndefined({
          _firestore_id: eventDoc.id,
          _log_firestore_id: logDoc.id,
          subject_id: d.subjectId ?? null,
          timestamp: toISOOrNull(d.timestamp),
          created_by: resolveRef(d.createdBy),
          data: d.data ?? null,
        })
      );
    }
  }

  writeJSON("life_events.json", records);
  return records.length;
}

async function exportTaskLists(): Promise<number> {
  const snapshot = await db.collection("taskLists").get();
  const records = snapshot.docs.map((doc) => {
    const d = doc.data();
    return omitUndefined({
      _firestore_id: doc.id,
      name: d.name ?? null,
      owners: d.owners ?? [],
      room_defs: d.roomDefs ?? null,
    });
  });
  writeJSON("task_lists.json", records);
  return records.length;
}

async function exportTasks(): Promise<number> {
  const listsSnapshot = await db.collection("taskLists").get();
  const records: Record<string, unknown>[] = [];

  for (const listDoc of listsSnapshot.docs) {
    const tasksSnapshot = await db
      .collection("taskLists")
      .doc(listDoc.id)
      .collection("tasks")
      .get();

    for (const taskDoc of tasksSnapshot.docs) {
      const d = taskDoc.data();
      records.push(
        omitUndefined({
          _firestore_id: taskDoc.id,
          _list_firestore_id: listDoc.id,
          name: d.name ?? null,
          description: d.description ?? null,
          room_id: d.roomId ?? null,
          frequency: d.frequency ?? null,
          last_completed: toISOOrNull(d.lastCompleted),
          snoozed_until: toISOOrNull(d.snoozedUntil),
          notify_users: d.notifyUsers ?? [],
          created_by: resolveRef(d.createdBy),
        })
      );
    }
  }

  writeJSON("tasks.json", records);
  return records.length;
}

async function exportTaskEvents(): Promise<number> {
  const listsSnapshot = await db.collection("taskLists").get();
  const records: Record<string, unknown>[] = [];

  for (const listDoc of listsSnapshot.docs) {
    const eventsSnapshot = await db
      .collection("taskLists")
      .doc(listDoc.id)
      .collection("events")
      .get();

    for (const eventDoc of eventsSnapshot.docs) {
      const d = eventDoc.data();
      records.push(
        omitUndefined({
          _firestore_id: eventDoc.id,
          _list_firestore_id: listDoc.id,
          subject_id: d.subjectId ?? null,
          timestamp: toISOOrNull(d.timestamp),
          created_by: resolveRef(d.createdBy),
          data: d.data ?? null,
        })
      );
    }
  }

  writeJSON("task_events.json", records);
  return records.length;
}

async function exportTravelLogs(): Promise<number> {
  const snapshot = await db.collection("travelLogs").get();
  const records = snapshot.docs.map((doc) => {
    const d = doc.data();
    return omitUndefined({
      _firestore_id: doc.id,
      name: d.name ?? null,
      owners: d.owners ?? [],
      checklists: d.checklists ?? null,
    });
  });
  writeJSON("travel_logs.json", records);
  return records.length;
}

async function exportTravelTrips(): Promise<number> {
  const logsSnapshot = await db.collection("travelLogs").get();
  const records: Record<string, unknown>[] = [];

  for (const logDoc of logsSnapshot.docs) {
    const tripsSnapshot = await db
      .collection("travelLogs")
      .doc(logDoc.id)
      .collection("trips")
      .get();

    for (const tripDoc of tripsSnapshot.docs) {
      const d = tripDoc.data();
      records.push(
        omitUndefined({
          _firestore_id: tripDoc.id,
          _log_firestore_id: logDoc.id,
          destination: d.destination ?? null,
          status: d.status ?? null,
          region: d.region ?? null,
          start_date: toISOOrNull(d.startDate),
          end_date: toISOOrNull(d.endDate),
          notes: d.notes ?? null,
          source_refs: d.sourceRefs ?? null,
          flagged_for_review: d.flaggedForReview ?? null,
          review_comment: d.reviewComment ?? null,
          checklist_done: d.checklistDone ?? null,
        })
      );
    }
  }

  writeJSON("travel_trips.json", records);
  return records.length;
}

async function exportTravelActivities(): Promise<number> {
  const logsSnapshot = await db.collection("travelLogs").get();
  const records: Record<string, unknown>[] = [];

  for (const logDoc of logsSnapshot.docs) {
    const activitiesSnapshot = await db
      .collection("travelLogs")
      .doc(logDoc.id)
      .collection("activities")
      .get();

    for (const actDoc of activitiesSnapshot.docs) {
      const d = actDoc.data();
      // Convert all camelCase fields to snake_case
      const mapped: Record<string, unknown> = {
        _firestore_id: actDoc.id,
        _log_firestore_id: logDoc.id,
      };
      for (const [key, value] of Object.entries(d)) {
        const snakeKey = key.replace(
          /[A-Z]/g,
          (letter) => `_${letter.toLowerCase()}`
        );
        if (key === "tripId") {
          mapped.trip_id = resolveRef(
            value as admin.firestore.DocumentReference | string
          );
        } else if (snakeKey !== key) {
          mapped[snakeKey] = value;
        } else {
          mapped[key] = value;
        }
      }
      records.push(omitUndefined(mapped));
    }
  }

  writeJSON("travel_activities.json", records);
  return records.length;
}

async function exportTravelItineraries(): Promise<number> {
  const logsSnapshot = await db.collection("travelLogs").get();
  const records: Record<string, unknown>[] = [];

  for (const logDoc of logsSnapshot.docs) {
    const itinSnapshot = await db
      .collection("travelLogs")
      .doc(logDoc.id)
      .collection("itineraries")
      .get();

    for (const itinDoc of itinSnapshot.docs) {
      const d = itinDoc.data();
      records.push(
        omitUndefined({
          _firestore_id: itinDoc.id,
          _log_firestore_id: logDoc.id,
          name: d.name ?? null,
          trip_id: resolveRef(d.tripId),
          is_active: d.isActive ?? null,
          days: d.days ?? null,
        })
      );
    }
  }

  writeJSON("travel_itineraries.json", records);
  return records.length;
}

// --- Main ---

interface ExportStep {
  label: string;
  fn: () => Promise<number>;
}

const EXPORT_STEPS: ExportStep[] = [
  { label: "users", fn: exportUsers },
  { label: "shopping_lists", fn: exportShoppingLists },
  { label: "shopping_items", fn: exportShoppingItems },
  { label: "shopping_history", fn: exportShoppingHistory },
  { label: "shopping_trips", fn: exportShoppingTrips },
  { label: "recipe_boxes", fn: exportRecipeBoxes },
  { label: "recipes", fn: exportRecipes },
  { label: "recipe_events", fn: exportRecipeEvents },
  { label: "life_logs", fn: exportLifeLogs },
  { label: "life_events", fn: exportLifeEvents },
  { label: "task_lists", fn: exportTaskLists },
  { label: "tasks", fn: exportTasks },
  { label: "task_events", fn: exportTaskEvents },
  { label: "travel_logs", fn: exportTravelLogs },
  { label: "travel_trips", fn: exportTravelTrips },
  { label: "travel_activities", fn: exportTravelActivities },
  { label: "travel_itineraries", fn: exportTravelItineraries },
];

async function main() {
  console.log("Firestore Data Export");
  console.log("Project: recipe-box-335721");
  console.log(`Output:  ${DATA_DIR}\n`);

  mkdirSync(DATA_DIR, { recursive: true });

  const summary: { label: string; count: number }[] = [];

  for (const step of EXPORT_STEPS) {
    process.stdout.write(`Exporting ${step.label}... `);
    try {
      const count = await step.fn();
      console.log(`${count} records`);
      summary.push({ label: step.label, count });
    } catch (err) {
      console.log(`ERROR`);
      console.error(`  Failed to export ${step.label}:`, err);
      summary.push({ label: step.label, count: -1 });
    }
  }

  console.log("\n========== Export Summary ==========\n");
  for (const { label, count } of summary) {
    if (count < 0) {
      console.log(`  ${label}: FAILED`);
    } else {
      console.log(`  ${label}: ${count} records`);
    }
  }
  const hasErrors = summary.some(({ count }) => count < 0);
  if (hasErrors) {
    console.log("\nExport completed with errors.");
    process.exit(1);
  }
  console.log("\nExport complete!");
  process.exit(0);
}

main().catch((error) => {
  console.error("Export failed:", error);
  process.exit(1);
});
