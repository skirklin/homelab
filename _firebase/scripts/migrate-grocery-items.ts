/**
 * Migration script to parse grocery items into ingredient + note using Claude.
 *
 * Prerequisites:
 *   npm install @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY=your-key
 *
 * Run with: npx ts-node scripts/migrate-grocery-items.ts [--dry-run] [--list-id=xxx]
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

interface GroceryItem {
  id: string;
  ingredient: string;
  note?: string;
  categoryId: string;
}

interface ParsedItem {
  ingredient: string;
  note: string | null;
}

interface ParseResult {
  original: string;
  parsed: ParsedItem;
}

async function parseItemsWithClaude(items: string[]): Promise<ParseResult[]> {
  const prompt = `Parse these grocery list items into ingredient and note (quantity/details).

Rules:
- The ingredient is the main item name (what you're buying)
- The note is optional quantity, size, brand, or other details
- If there's no clear note, leave it as null
- Preserve the ingredient name as the user wrote it (casing, etc.)

Examples:
- "milk 1 gallon" → ingredient: "milk", note: "1 gallon"
- "eggs" → ingredient: "eggs", note: null
- "cheddar cheese 8oz" → ingredient: "cheddar cheese", note: "8oz"
- "Organic bananas 2 lbs" → ingredient: "Organic bananas", note: "2 lbs"
- "chicken breast (boneless)" → ingredient: "chicken breast", note: "boneless"

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

  const itemsSnapshot = await db.collection("lists").doc(listId).collection("items").get();
  const stats = { processed: 0, updated: 0, skipped: 0 };

  if (itemsSnapshot.empty) {
    console.log("  No items found");
    return stats;
  }

  // Collect items that need migration (have ingredient but no note, and ingredient looks like it has quantity)
  const itemsToProcess: { doc: admin.firestore.QueryDocumentSnapshot; ingredient: string }[] = [];

  for (const doc of itemsSnapshot.docs) {
    const data = doc.data();
    stats.processed++;

    // Get the current ingredient (might be from legacy 'name' field)
    const ingredient = data.ingredient || data.name || "";

    // Skip if already has a note
    if (data.note) {
      stats.skipped++;
      continue;
    }

    // Skip if ingredient is empty
    if (!ingredient.trim()) {
      stats.skipped++;
      continue;
    }

    itemsToProcess.push({ doc, ingredient });
  }

  if (itemsToProcess.length === 0) {
    console.log("  No items need migration");
    return stats;
  }

  console.log(`  Found ${itemsToProcess.length} items to process`);

  // Process in batches of 20 to avoid token limits
  const batchSize = 20;
  for (let i = 0; i < itemsToProcess.length; i += batchSize) {
    const batch = itemsToProcess.slice(i, i + batchSize);
    const ingredients = batch.map(b => b.ingredient);

    console.log(`  Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(itemsToProcess.length / batchSize)}...`);

    try {
      const parsed = await parseItemsWithClaude(ingredients);

      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        const result = parsed[j];

        if (!result || !result.parsed) {
          console.log(`    ✗ "${item.ingredient}": No parse result`);
          continue;
        }

        const { ingredient: newIngredient, note } = result.parsed;

        // Check if anything changed
        if (newIngredient === item.ingredient && !note) {
          console.log(`    - "${item.ingredient}": No change needed`);
          stats.skipped++;
          continue;
        }

        console.log(`    ✓ "${item.ingredient}" → ingredient: "${newIngredient}", note: ${note ? `"${note}"` : "null"}`);

        if (!dryRun) {
          await item.doc.ref.update({
            ingredient: newIngredient,
            note: note || admin.firestore.FieldValue.delete(),
          });
        }

        stats.updated++;
      }
    } catch (error) {
      console.error(`    Error processing batch: ${error}`);
    }

    // Small delay between batches to avoid rate limits
    if (i + batchSize < itemsToProcess.length) {
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

  console.log("Grocery Item Migration (ingredient + note parsing)");
  console.log("==================================================");
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
  console.log(`Total items processed: ${totalProcessed}`);
  console.log(`Items updated:         ${totalUpdated}`);
  console.log(`Items skipped:         ${totalSkipped}`);

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
