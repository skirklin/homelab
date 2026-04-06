/**
 * Migration script to parse grocery history entries into ingredient-only using Claude.
 * This ensures autocomplete and category lookup work correctly with the new format.
 *
 * Prerequisites:
 *   npm install @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY=your-key
 *
 * Run with: npx tsx scripts/migrate-grocery-history.ts [--dry-run] [--list-id=xxx]
 */

import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";

// Initialize Firebase
admin.initializeApp({
  projectId: "recipe-box-335721",
});

const db = admin.firestore();

// Initialize Anthropic
const anthropic = new Anthropic();

interface HistoryEntry {
  docId: string;
  name?: string;       // Legacy field
  ingredient?: string; // New field
  categoryId: string;
  lastAdded: admin.firestore.Timestamp;
}

interface ParsedItem {
  ingredient: string;
  note: string | null;
}

interface ParseResult {
  original: string;
  parsed: ParsedItem;
}

function normalizeIngredient(ingredient: string): string {
  return ingredient.toLowerCase().trim();
}

async function parseItemsWithClaude(items: string[]): Promise<ParseResult[]> {
  const prompt = `Parse these grocery list items to extract just the ingredient name (removing quantities/notes).

Rules:
- Extract the core ingredient name only
- Remove quantities, sizes, brands, and other details
- Preserve the ingredient name casing as it should appear
- The "note" field captures what was removed (or null if nothing)

Examples:
- "milk 1 gallon" → ingredient: "milk", note: "1 gallon"
- "eggs" → ingredient: "eggs", note: null
- "cheddar cheese 8oz" → ingredient: "cheddar cheese", note: "8oz"
- "Organic bananas 2 lbs" → ingredient: "Organic bananas", note: "2 lbs"
- "1 lb 90-10 ground beef" → ingredient: "ground beef", note: "1 lb 90-10"
- "TJ multigrain crackers" → ingredient: "multigrain crackers", note: "TJ"

Items to parse:
${items.map((item, i) => `${i + 1}. "${item}"`).join("\n")}

Respond with JSON array only, no explanation:
[{"original": "...", "parsed": {"ingredient": "...", "note": "..." or null}}, ...]`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.content[0];
  if (content.type !== "text") {
    throw new Error("Unexpected response type");
  }

  // Extract JSON from response (handle potential markdown code blocks)
  let jsonText = content.text.trim();
  if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  return JSON.parse(jsonText) as ParseResult[];
}

async function migrateList(listId: string, dryRun: boolean): Promise<{ processed: number; updated: number; skipped: number }> {
  console.log(`\nProcessing list: ${listId}`);

  const historyRef = db.collection("lists").doc(listId).collection("history");
  const historySnapshot = await historyRef.get();
  const stats = { processed: 0, updated: 0, skipped: 0 };

  if (historySnapshot.empty) {
    console.log("  No history found");
    return stats;
  }

  // Collect entries that might need migration
  const entriesToProcess: { doc: admin.firestore.QueryDocumentSnapshot; currentName: string }[] = [];

  for (const doc of historySnapshot.docs) {
    const data = doc.data() as HistoryEntry;
    stats.processed++;

    // Get the current name (might be from legacy 'name' field or new 'ingredient' field)
    const currentName = data.ingredient || data.name || "";

    // Skip if empty
    if (!currentName.trim()) {
      stats.skipped++;
      continue;
    }

    entriesToProcess.push({ doc, currentName });
  }

  if (entriesToProcess.length === 0) {
    console.log("  No entries need migration");
    return stats;
  }

  console.log(`  Found ${entriesToProcess.length} entries to process`);

  // Process in batches of 20
  const batchSize = 20;
  for (let i = 0; i < entriesToProcess.length; i += batchSize) {
    const batch = entriesToProcess.slice(i, i + batchSize);
    const names = batch.map(b => b.currentName);

    console.log(`  Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(entriesToProcess.length / batchSize)}...`);

    try {
      const parsed = await parseItemsWithClaude(names);

      for (let j = 0; j < batch.length; j++) {
        const entry = batch[j];
        const result = parsed[j];
        const data = entry.doc.data() as HistoryEntry;

        if (!result || !result.parsed) {
          console.log(`    ✗ "${entry.currentName}": No parse result`);
          continue;
        }

        const newIngredient = result.parsed.ingredient;
        const newNormalizedId = normalizeIngredient(newIngredient);
        const oldNormalizedId = entry.doc.id;

        // Check if the ingredient changed (after normalization)
        if (newNormalizedId === oldNormalizedId && data.ingredient === newIngredient) {
          console.log(`    - "${entry.currentName}": No change needed`);
          stats.skipped++;
          continue;
        }

        console.log(`    ✓ "${entry.currentName}" → "${newIngredient}" (doc: ${oldNormalizedId} → ${newNormalizedId})`);

        if (!dryRun) {
          // If the document ID needs to change, delete old and create new
          if (newNormalizedId !== oldNormalizedId) {
            // Create new document with correct ID
            await historyRef.doc(newNormalizedId).set({
              ingredient: newIngredient,
              categoryId: data.categoryId,
              lastAdded: data.lastAdded,
            });
            // Delete old document
            await entry.doc.ref.delete();
          } else {
            // Just update the ingredient field
            await entry.doc.ref.update({
              ingredient: newIngredient,
            });
          }
        }

        stats.updated++;
      }
    } catch (error) {
      console.error(`    Error processing batch: ${error}`);
    }

    // Small delay between batches
    if (i + batchSize < entriesToProcess.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const listIdArg = args.find(a => a.startsWith("--list-id="));
  const specificListId = listIdArg?.split("=")[1];

  console.log("Grocery History Migration (extract ingredient names)");
  console.log("=====================================================");
  console.log(`Mode: ${dryRun ? "DRY RUN (no changes will be made)" : "LIVE"}`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\nError: ANTHROPIC_API_KEY environment variable not set");
    process.exit(1);
  }

  let listIds: string[];

  if (specificListId) {
    listIds = [specificListId];
    console.log(`\nProcessing specific list: ${specificListId}`);
  } else {
    // Get all lists
    const listsSnapshot = await db.collection("lists").get();
    listIds = listsSnapshot.docs.map(doc => doc.id);
    console.log(`\nFound ${listIds.length} lists to process`);
  }

  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const listId of listIds) {
    const stats = await migrateList(listId, dryRun);
    totalProcessed += stats.processed;
    totalUpdated += stats.updated;
    totalSkipped += stats.skipped;
  }

  console.log("\n========== Migration Summary ==========");
  console.log(`Total entries processed: ${totalProcessed}`);
  console.log(`Entries updated:         ${totalUpdated}`);
  console.log(`Entries skipped:         ${totalSkipped}`);

  if (dryRun) {
    console.log("\n(Dry run - no changes were made)");
  }

  console.log("\n✓ Migration complete!");
  process.exit(0);
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
