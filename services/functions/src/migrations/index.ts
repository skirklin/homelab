/**
 * One-time migration functions for data schema changes.
 * These are manually triggered via callable functions.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { db } from "../firebase";

// ===== Cooking Log Migration =====

/**
 * Migrate cookingLog arrays on recipes to events subcollection documents.
 */
export const migrateCookingLogs = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be authenticated");
  }

  const userId = request.auth.uid;
  console.log(`Starting cooking log migration for user ${userId}`);

  // Get all boxes the user owns
  const boxesSnapshot = await db
    .collection("boxes")
    .where("owners", "array-contains", userId)
    .get();

  let totalMigrated = 0;
  let totalRecipes = 0;

  for (const boxDoc of boxesSnapshot.docs) {
    const boxId = boxDoc.id;

    // Get all recipes in this box
    const recipesSnapshot = await db
      .collection("boxes")
      .doc(boxId)
      .collection("recipes")
      .get();

    for (const recipeDoc of recipesSnapshot.docs) {
      const recipeId = recipeDoc.id;
      const recipeData = recipeDoc.data();
      const cookingLog = recipeData.cookingLog as
        | Array<{
            madeAt: Timestamp;
            madeBy: string;
            note?: string;
          }>
        | undefined;

      if (!cookingLog || cookingLog.length === 0) {
        continue;
      }

      totalRecipes++;

      // Create events for each cooking log entry
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
        totalMigrated++;
      }

      // Remove cookingLog from recipe after migration
      batch.update(recipeDoc.ref, {
        cookingLog: FieldValue.delete(),
      });

      await batch.commit();
      console.log(`Migrated ${cookingLog.length} entries from recipe ${recipeId}`);
    }
  }

  console.log(
    `Migration complete: ${totalMigrated} entries from ${totalRecipes} recipes`
  );
  return {
    success: true,
    recipesProcessed: totalRecipes,
    entriesMigrated: totalMigrated,
  };
});

// ===== Life Entries Migration =====

/**
 * Migrate entries subcollection to unified events format.
 *
 * Changes:
 * - Rename widgetId to subjectId
 * - Move notes and source into data
 */
export const migrateLifeEntries = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be authenticated");
  }

  const userId = request.auth.uid;
  console.log(`Starting life entries migration for user ${userId}`);

  // Get all life logs the user owns
  const logsSnapshot = await db
    .collection("lifeLogs")
    .where("owners", "array-contains", userId)
    .get();

  let totalMigrated = 0;
  let totalLogs = 0;

  for (const logDoc of logsSnapshot.docs) {
    const logId = logDoc.id;

    // Get all entries in this log
    const entriesSnapshot = await db
      .collection("lifeLogs")
      .doc(logId)
      .collection("entries")
      .get();

    if (entriesSnapshot.empty) {
      continue;
    }

    totalLogs++;
    const eventsRef = db.collection("lifeLogs").doc(logId).collection("events");

    // Process in batches of 500 (Firestore batch limit)
    const entries = entriesSnapshot.docs;
    const batchSize = 500;

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = db.batch();
      const batchEntries = entries.slice(i, i + batchSize);

      for (const entryDoc of batchEntries) {
        const data = entryDoc.data();

        // Build unified event data - move notes and source into data field
        const eventData: Record<string, unknown> = { ...data.data };
        if (data.source) {
          eventData.source = data.source;
        }
        if (data.notes) {
          eventData.notes = data.notes;
        }

        // Create event with unified schema
        const eventRef = eventsRef.doc(entryDoc.id); // Keep same ID
        batch.set(eventRef, {
          subjectId: data.widgetId,
          timestamp: data.timestamp,
          createdAt: data.createdAt || data.timestamp,
          createdBy: data.createdBy,
          data: eventData,
        });

        // Delete old entry
        batch.delete(entryDoc.ref);
        totalMigrated++;
      }

      await batch.commit();
      console.log(
        `Migrated batch of ${batchEntries.length} entries from log ${logId}`
      );
    }
  }

  console.log(
    `Life entries migration complete: ${totalMigrated} entries from ${totalLogs} logs`
  );
  return {
    success: true,
    logsProcessed: totalLogs,
    entriesMigrated: totalMigrated,
  };
});

// ===== Upkeep Completions Migration =====

/**
 * Migrate completions subcollection to unified events format.
 *
 * Changes:
 * - Rename taskId to subjectId
 * - Rename completedBy to createdBy
 * - Rename completedAt to timestamp
 * - Move notes into data
 */
export const migrateUpkeepCompletions = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be authenticated");
  }

  const userId = request.auth.uid;
  console.log(`Starting upkeep completions migration for user ${userId}`);

  // Get all task lists the user owns
  const listsSnapshot = await db
    .collection("taskLists")
    .where("owners", "array-contains", userId)
    .get();

  let totalMigrated = 0;
  let totalLists = 0;

  for (const listDoc of listsSnapshot.docs) {
    const listId = listDoc.id;

    // Get all completions in this list
    const completionsSnapshot = await db
      .collection("taskLists")
      .doc(listId)
      .collection("completions")
      .get();

    if (completionsSnapshot.empty) {
      continue;
    }

    totalLists++;
    const eventsRef = db.collection("taskLists").doc(listId).collection("events");

    // Process in batches of 500 (Firestore batch limit)
    const completions = completionsSnapshot.docs;
    const batchSize = 500;

    for (let i = 0; i < completions.length; i += batchSize) {
      const batch = db.batch();
      const batchCompletions = completions.slice(i, i + batchSize);

      for (const compDoc of batchCompletions) {
        const data = compDoc.data();

        // Create event with unified schema
        const eventRef = eventsRef.doc(compDoc.id); // Keep same ID
        batch.set(eventRef, {
          subjectId: data.taskId,
          timestamp: data.completedAt,
          createdAt: data.completedAt,
          createdBy: data.completedBy,
          data: data.notes ? { notes: data.notes } : {},
        });

        // Delete old completion
        batch.delete(compDoc.ref);
        totalMigrated++;
      }

      await batch.commit();
      console.log(
        `Migrated batch of ${batchCompletions.length} completions from list ${listId}`
      );
    }
  }

  console.log(
    `Upkeep completions migration complete: ${totalMigrated} completions from ${totalLists} lists`
  );
  return {
    success: true,
    listsProcessed: totalLists,
    completionsMigrated: totalMigrated,
  };
});

// ===== Backfill Box Subscribers =====

/**
 * Scan all user documents, find which boxes each user subscribes to,
 * and add their UID to the box's subscribers array.
 */
export const backfillBoxSubscribers = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be authenticated");
  }

  console.log("Starting box subscribers backfill");

  // Build a map: boxId -> set of subscriber UIDs
  const boxSubscribers = new Map<string, Set<string>>();

  const usersSnapshot = await db.collection("users").get();
  for (const userDoc of usersSnapshot.docs) {
    const userId = userDoc.id;
    const data = userDoc.data();
    const boxes = data.boxes as FirebaseFirestore.DocumentReference[] | undefined;

    if (!boxes || boxes.length === 0) continue;

    for (const boxRef of boxes) {
      const boxId = boxRef.id;
      if (!boxSubscribers.has(boxId)) {
        boxSubscribers.set(boxId, new Set());
      }
      boxSubscribers.get(boxId)!.add(userId);
    }
  }

  // Write subscribers to each box
  let totalBoxes = 0;
  const batchSize = 500;
  const entries = Array.from(boxSubscribers.entries());

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = db.batch();
    const batchEntries = entries.slice(i, i + batchSize);

    for (const [boxId, subscribers] of batchEntries) {
      const boxRef = db.doc(`boxes/${boxId}`);
      batch.update(boxRef, { subscribers: Array.from(subscribers) });
      totalBoxes++;
    }

    await batch.commit();
    console.log(`Updated batch of ${batchEntries.length} boxes`);
  }

  console.log(`Backfill complete: ${totalBoxes} boxes updated from ${usersSnapshot.size} users`);
  return {
    success: true,
    boxesUpdated: totalBoxes,
    usersScanned: usersSnapshot.size,
  };
});
