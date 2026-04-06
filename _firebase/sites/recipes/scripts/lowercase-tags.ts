import { initializeApp, cert, ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";

// CLI arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const USE_EMULATOR = args.includes("--emulator");

if (DRY_RUN) {
  console.log("🔒 DRY RUN MODE - no changes will be written\n");
}
if (USE_EMULATOR) {
  console.log("🖥️  EMULATOR MODE - connecting to local Firestore\n");
}

// Initialize Firebase
function initFirebase() {
  if (USE_EMULATOR) {
    process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
    initializeApp({ projectId: "recipe-box-335721" });
  } else {
    const serviceAccountPath = path.join(process.cwd(), "service-account-key.json");
    if (!fs.existsSync(serviceAccountPath)) {
      console.error("Error: service-account-key.json not found");
      console.error("Download it from Firebase Console > Project Settings > Service Accounts");
      process.exit(1);
    }
    const serviceAccount = JSON.parse(
      fs.readFileSync(serviceAccountPath, "utf-8")
    ) as ServiceAccount;
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

async function main() {
  console.log("Lowercase Tags Script");
  console.log("=====================\n");

  const db = initFirebase();

  const boxesSnapshot = await db.collection("boxes").get();
  console.log(`Found ${boxesSnapshot.size} boxes\n`);

  let totalRecipes = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const boxDoc of boxesSnapshot.docs) {
    const boxData = boxDoc.data();
    console.log(`\n📦 Box: ${boxData.data?.name || boxDoc.id}`);

    const recipesSnapshot = await db
      .collection("boxes")
      .doc(boxDoc.id)
      .collection("recipes")
      .get();

    for (const recipeDoc of recipesSnapshot.docs) {
      totalRecipes++;
      const recipeData = recipeDoc.data();
      const recipe = recipeData.data;
      const recipeName = recipe?.name || "Unnamed Recipe";

      const currentTags = recipe?.recipeCategory;

      // Skip if no tags
      if (!currentTags || (Array.isArray(currentTags) && currentTags.length === 0)) {
        console.log(`  ⏭️  ${recipeName} - no tags`);
        skippedCount++;
        continue;
      }

      // Normalize to array
      const tagsArray = Array.isArray(currentTags) ? currentTags : [currentTags];

      // Check if any tags need lowercasing
      const lowercasedTags = tagsArray.map((t: string) => t.toLowerCase());
      const needsUpdate = tagsArray.some((t: string, i: number) => t !== lowercasedTags[i]);

      if (!needsUpdate) {
        console.log(`  ✓ ${recipeName} - already lowercase`);
        skippedCount++;
        continue;
      }

      console.log(`  🔄 ${recipeName}`);
      console.log(`     Before: ${tagsArray.join(", ")}`);
      console.log(`     After:  ${lowercasedTags.join(", ")}`);

      if (DRY_RUN) {
        console.log(`     🔒 Would update (dry run)`);
      } else {
        await db
          .collection("boxes")
          .doc(boxDoc.id)
          .collection("recipes")
          .doc(recipeDoc.id)
          .update({ "data.recipeCategory": lowercasedTags });
        console.log(`     ✅ Updated`);
      }
      updatedCount++;
    }
  }

  console.log("\n=====================");
  console.log(`Total recipes: ${totalRecipes}`);
  console.log(`Updated: ${updatedCount}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`Skipped: ${skippedCount}`);
}

main().catch(console.error);
