import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

// Connect to emulators
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
initializeApp({ projectId: "recipe-box-335721" });
const db = getFirestore();
const auth = getAuth();

// Sample recipes - some with pending enrichments, some without
const sampleRecipes = [
  {
    data: {
      name: "Classic Chocolate Chip Cookies",
      description: "", // Missing description
      recipeIngredient: [
        "2 1/4 cups all-purpose flour",
        "1 cup butter, softened",
        "3/4 cup sugar",
        "3/4 cup brown sugar",
        "2 eggs",
        "1 tsp vanilla",
        "1 tsp baking soda",
        "2 cups chocolate chips",
      ],
      recipeInstructions: [
        { text: "Preheat oven to 375°F" },
        { text: "Mix flour and baking soda" },
        { text: "Beat butter and sugars until creamy" },
        { text: "Add eggs and vanilla to butter mixture" },
        { text: "Gradually blend in flour mixture" },
        { text: "Stir in chocolate chips" },
        { text: "Drop rounded tablespoons onto baking sheets" },
        { text: "Bake 9-11 minutes or until golden brown" },
      ],
      recipeCategory: ["dessert"],
    },
    pendingEnrichment: {
      description:
        "Crispy on the edges, chewy in the middle - these classic chocolate chip cookies are the perfect sweet treat for any occasion.",
      suggestedTags: ["dessert", "baking", "cookies", "chocolate", "kid-friendly"],
      reasoning:
        "Added specific cookie-related tags and a description highlighting the texture contrast that makes these cookies special.",
      generatedAt: Timestamp.now(),
      model: "claude-sonnet-4-20250514",
    },
  },
  {
    data: {
      name: "Quick Weeknight Pasta",
      description: "A simple pasta dish ready in 20 minutes",
      recipeIngredient: [
        "1 lb spaghetti",
        "4 cloves garlic, minced",
        "1/4 cup olive oil",
        "Red pepper flakes",
        "Fresh parsley",
        "Parmesan cheese",
      ],
      recipeInstructions: [
        { text: "Cook pasta according to package directions" },
        { text: "Meanwhile, heat olive oil over medium heat" },
        { text: "Add garlic and red pepper flakes, cook 1 minute" },
        { text: "Toss pasta with garlic oil" },
        { text: "Top with parsley and parmesan" },
      ],
      recipeCategory: "dinner",
    },
    pendingEnrichment: {
      description:
        "A simple pasta dish ready in 20 minutes", // Same as existing
      suggestedTags: ["dinner", "pasta", "italian", "quick", "vegetarian", "weeknight"],
      reasoning:
        "This aglio e olio style pasta is perfect for busy weeknights. Added quick/weeknight tags and vegetarian since it has no meat.",
      generatedAt: Timestamp.now(),
      model: "claude-sonnet-4-20250514",
    },
  },
  {
    data: {
      name: "Grandma's Beef Stew",
      description: "",
      recipeIngredient: [
        "2 lbs beef chuck, cubed",
        "4 potatoes, cubed",
        "4 carrots, sliced",
        "1 onion, diced",
        "4 cups beef broth",
        "2 tbsp tomato paste",
        "Fresh thyme",
      ],
      recipeInstructions: [
        { text: "Brown beef in batches in a dutch oven" },
        { text: "Sauté onions until soft" },
        { text: "Add broth and tomato paste, bring to simmer" },
        { text: "Add potatoes, carrots, and thyme" },
        { text: "Cover and cook 2 hours until beef is tender" },
      ],
      recipeCategory: [],
    },
    // No pending enrichment - needs processing
  },
  {
    data: {
      name: "Fresh Garden Salad",
      description: "A light and refreshing salad",
      recipeIngredient: [
        "Mixed greens",
        "Cherry tomatoes",
        "Cucumber",
        "Red onion",
        "Balsamic vinaigrette",
      ],
      recipeInstructions: [
        { text: "Wash and dry all vegetables" },
        { text: "Combine greens, tomatoes, cucumber, and onion" },
        { text: "Drizzle with vinaigrette and toss" },
      ],
      recipeCategory: ["salad", "healthy"],
    },
    // No pending enrichment - already has good tags
  },
];

const TEST_EMAIL = "test@example.com";
const TEST_PASSWORD = "testpassword123";

async function seed() {
  console.log("Seeding emulator with test data...\n");

  // Clear existing data first
  console.log("Clearing existing data...");
  const existingBoxes = await db.collection("boxes").get();
  for (const boxDoc of existingBoxes.docs) {
    // Delete all recipes in the box
    const recipes = await boxDoc.ref.collection("recipes").get();
    for (const recipe of recipes.docs) {
      await recipe.ref.delete();
    }
    await boxDoc.ref.delete();
  }
  const existingUsers = await db.collection("users").get();
  for (const userDoc of existingUsers.docs) {
    await userDoc.ref.delete();
  }
  console.log("✓ Cleared existing data\n");

  // Create an auth user you can sign in with
  let userId: string;
  try {
    const userRecord = await auth.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      displayName: "Test User",
    });
    userId = userRecord.uid;
    console.log(`✓ Created auth user: ${TEST_EMAIL} / ${TEST_PASSWORD}`);
  } catch (error: unknown) {
    // User might already exist
    const existingUser = await auth.getUserByEmail(TEST_EMAIL);
    userId = existingUser.uid;
    console.log(`✓ Using existing auth user: ${TEST_EMAIL}`);
  }

  // Create user document in Firestore
  await db.collection("users").doc(userId).set({
    name: "Test User",
    visibility: "private",
    lastSeen: Timestamp.now(),
    newSeen: Timestamp.now(),
    wakeLockSeen: false,
    boxes: [],
  });
  console.log("✓ Created user document");

  // Create a test box
  const boxRef = await db.collection("boxes").add({
    data: { name: "Test Recipes" },
    owners: [userId],
    creator: userId,
    visibility: "private",
    created: Timestamp.now(),
    updated: Timestamp.now(),
    lastUpdatedBy: userId,
  });
  console.log(`✓ Created box: ${boxRef.id}`);

  // Update user with box reference
  await db
    .collection("users")
    .doc(userId)
    .update({
      boxes: [boxRef],
    });

  // Add recipes
  for (const recipe of sampleRecipes) {
    const recipeDoc: Record<string, unknown> = {
      data: recipe.data,
      owners: [userId],
      creator: userId,
      visibility: "private",
      created: Timestamp.now(),
      updated: Timestamp.now(),
      lastUpdatedBy: userId,
    };

    if (recipe.pendingEnrichment) {
      recipeDoc.pendingEnrichment = recipe.pendingEnrichment;
    }

    const recipeRef = await boxRef.collection("recipes").add(recipeDoc);
    const hasPending = recipe.pendingEnrichment ? "📋" : "  ";
    console.log(`  ${hasPending} Added recipe: ${recipe.data.name}`);
  }

  console.log("\n✅ Seeding complete!");
  console.log("\n📋 Recipes with pending enrichments ready for review");
  console.log("\n🔑 Login credentials:");
  console.log(`   Email: ${TEST_EMAIL}`);
  console.log(`   Password: ${TEST_PASSWORD}`);
  console.log("\nOpen http://localhost:5173 and sign in to see the test data.");
}

seed().catch(console.error);
