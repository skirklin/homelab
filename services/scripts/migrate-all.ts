/**
 * Local migration script to convert legacy data to unified events format.
 * Run with: npx ts-node scripts/migrate-all.ts
 */

import * as admin from "firebase-admin";

// Initialize with default credentials (uses GOOGLE_APPLICATION_CREDENTIALS or gcloud auth)
admin.initializeApp({
  projectId: "recipe-box-335721",
});

const db = admin.firestore();

interface MigrationStats {
  processed: number;
  migrated: number;
  skipped: number;
  errors: number;
}

async function migrateCookingLogs(): Promise<MigrationStats> {
  console.log("\n=== Migrating Cooking Logs ===\n");
  const stats: MigrationStats = { processed: 0, migrated: 0, skipped: 0, errors: 0 };

  const boxesSnapshot = await db.collection("boxes").get();
  console.log(`Found ${boxesSnapshot.size} boxes`);

  for (const boxDoc of boxesSnapshot.docs) {
    const boxId = boxDoc.id;
    const recipesSnapshot = await db.collection("boxes").doc(boxId).collection("recipes").get();

    for (const recipeDoc of recipesSnapshot.docs) {
      const recipeId = recipeDoc.id;
      const recipeData = recipeDoc.data();
      const cookingLog = recipeData.cookingLog as Array<{
        madeAt: admin.firestore.Timestamp;
        madeBy: string;
        note?: string;
      }> | undefined;

      if (!cookingLog || cookingLog.length === 0) {
        continue;
      }

      stats.processed++;

      // Check if already migrated
      const existingEvents = await db.collection("boxes").doc(boxId)
        .collection("events")
        .where("subjectId", "==", recipeId)
        .limit(1)
        .get();

      if (!existingEvents.empty) {
        stats.skipped++;
        continue;
      }

      try {
        const eventsRef = db.collection("boxes").doc(boxId).collection("events");
        const batch = db.batch();

        for (const entry of cookingLog) {
          const eventRef = eventsRef.doc();
          batch.set(eventRef, {
            subjectId: recipeId,
            timestamp: entry.madeAt,
            createdAt: entry.madeAt,
            createdBy: entry.madeBy,
            data: entry.note ? { notes: entry.note } : {},
          });
        }

        await batch.commit();
        stats.migrated += cookingLog.length;
        console.log(`  ✓ Recipe ${recipeId}: ${cookingLog.length} entries`);
      } catch (error) {
        stats.errors++;
        console.error(`  ✗ Recipe ${recipeId}: ${error}`);
      }
    }
  }

  return stats;
}

async function migrateLifeEntries(): Promise<MigrationStats> {
  console.log("\n=== Migrating Life Tracker Entries ===\n");
  const stats: MigrationStats = { processed: 0, migrated: 0, skipped: 0, errors: 0 };

  const logsSnapshot = await db.collection("lifeLogs").get();
  console.log(`Found ${logsSnapshot.size} life logs`);

  for (const logDoc of logsSnapshot.docs) {
    const logId = logDoc.id;
    const entriesSnapshot = await db.collection("lifeLogs").doc(logId).collection("entries").get();

    if (entriesSnapshot.empty) {
      continue;
    }

    stats.processed++;

    // Check if already migrated
    const existingEvents = await db.collection("lifeLogs").doc(logId)
      .collection("events")
      .limit(1)
      .get();

    if (!existingEvents.empty) {
      console.log(`  - Log ${logId}: skipped (already has events)`);
      stats.skipped++;
      continue;
    }

    try {
      const eventsRef = db.collection("lifeLogs").doc(logId).collection("events");
      const entries = entriesSnapshot.docs;
      const batchSize = 500;

      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = db.batch();
        const batchEntries = entries.slice(i, i + batchSize);

        for (const entryDoc of batchEntries) {
          const data = entryDoc.data();

          const eventData: Record<string, unknown> = { ...data.data };
          if (data.source) eventData.source = data.source;
          if (data.notes) eventData.notes = data.notes;

          const eventRef = eventsRef.doc(entryDoc.id);
          batch.set(eventRef, {
            subjectId: data.widgetId || data.activityId || "unknown",
            timestamp: data.timestamp,
            createdAt: data.createdAt || data.timestamp,
            createdBy: data.createdBy || "unknown",
            data: eventData,
          });
        }

        await batch.commit();
      }

      stats.migrated += entries.length;
      console.log(`  ✓ Log ${logId}: ${entries.length} entries`);
    } catch (error) {
      stats.errors++;
      console.error(`  ✗ Log ${logId}: ${error}`);
    }
  }

  return stats;
}

async function migrateUpkeepCompletions(): Promise<MigrationStats> {
  console.log("\n=== Migrating Upkeep Completions ===\n");
  const stats: MigrationStats = { processed: 0, migrated: 0, skipped: 0, errors: 0 };

  const listsSnapshot = await db.collection("taskLists").get();
  console.log(`Found ${listsSnapshot.size} task lists`);

  for (const listDoc of listsSnapshot.docs) {
    const listId = listDoc.id;
    const completionsSnapshot = await db.collection("taskLists").doc(listId).collection("completions").get();

    if (completionsSnapshot.empty) {
      continue;
    }

    stats.processed++;

    // Check if already migrated
    const existingEvents = await db.collection("taskLists").doc(listId)
      .collection("events")
      .limit(1)
      .get();

    if (!existingEvents.empty) {
      console.log(`  - List ${listId}: skipped (already has events)`);
      stats.skipped++;
      continue;
    }

    try {
      const eventsRef = db.collection("taskLists").doc(listId).collection("events");
      const completions = completionsSnapshot.docs;
      const batchSize = 500;

      for (let i = 0; i < completions.length; i += batchSize) {
        const batch = db.batch();
        const batchCompletions = completions.slice(i, i + batchSize);

        for (const compDoc of batchCompletions) {
          const data = compDoc.data();

          const eventRef = eventsRef.doc(compDoc.id);
          batch.set(eventRef, {
            subjectId: data.taskId,
            timestamp: data.completedAt,
            createdAt: data.completedAt,
            createdBy: data.completedBy,
            data: data.notes ? { notes: data.notes } : {},
          });
        }

        await batch.commit();
      }

      stats.migrated += completions.length;
      console.log(`  ✓ List ${listId}: ${completions.length} completions`);
    } catch (error) {
      stats.errors++;
      console.error(`  ✗ List ${listId}: ${error}`);
    }
  }

  return stats;
}

async function main() {
  console.log("Starting data migration to unified events format...");
  console.log("Project: recipe-box-335721\n");

  const cookingStats = await migrateCookingLogs();
  const lifeStats = await migrateLifeEntries();
  const upkeepStats = await migrateUpkeepCompletions();

  console.log("\n========== Migration Summary ==========\n");
  console.log("Cooking Logs:");
  console.log(`  Recipes processed: ${cookingStats.processed}`);
  console.log(`  Entries migrated:  ${cookingStats.migrated}`);
  console.log(`  Skipped:           ${cookingStats.skipped}`);
  console.log(`  Errors:            ${cookingStats.errors}`);

  console.log("\nLife Tracker:");
  console.log(`  Logs processed:    ${lifeStats.processed}`);
  console.log(`  Entries migrated:  ${lifeStats.migrated}`);
  console.log(`  Skipped:           ${lifeStats.skipped}`);
  console.log(`  Errors:            ${lifeStats.errors}`);

  console.log("\nUpkeep:");
  console.log(`  Lists processed:   ${upkeepStats.processed}`);
  console.log(`  Completions migrated: ${upkeepStats.migrated}`);
  console.log(`  Skipped:           ${upkeepStats.skipped}`);
  console.log(`  Errors:            ${upkeepStats.errors}`);

  console.log("\n✓ Migration complete!");
  process.exit(0);
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
