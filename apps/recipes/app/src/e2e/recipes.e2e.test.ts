/**
 * End-to-end tests for Recipes app using the actual pocketbase.ts functions.
 *
 * Run with: npm test -- --run src/e2e
 * Requires PocketBase running: docker compose -f docker-compose.test.yml up -d
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initTestPocketBase,
  createTestUser,
  createUserWithoutSignIn,
  signInAsUser,
  cleanupTestPocketBase,
  TestCleanup,
  createTestBox,
  createTestRecipe,
  type TestContext,
} from "@kirkl/shared/test-utils";
import {
  addBox,
  addRecipe,
  saveRecipe,
  deleteRecipe,
  deleteBox,
  getUser,
  getBox,
  getRecipes,
  subscribeToBox,
  unsubscribeFromBox,
  setBoxVisibility,
  setRecipeVisibility,
  getCookingLogEvents,
  addCookingLogEvent,
  updateCookingLogEvent,
  deleteCookingLogEvent,
  applyChanges,
  rejectChanges,
} from "../pocketbase";
import { RecipeEntry } from "../storage";
import { EnrichmentStatus, Visibility } from "../types";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await initTestPocketBase();
});

afterAll(async () => {
  await cleanupTestPocketBase(ctx);
});

// ─── Box Management ──────────────────────────────────────────────────────────

describe("addBox", () => {
  it("creates a recipe box and links it to the user", async () => {
    const user = await createTestUser(ctx);
    const userEntry = await getUser(user.id);
    expect(userEntry).toBeDefined();

    const result = await addBox(userEntry!, "My Recipes");
    expect(result).toBeDefined();
    expect(result!.id).toBeTruthy();

    // Verify via admin client
    const boxRecord = await ctx.pb.collection("recipe_boxes").getOne(result!.id);
    expect(boxRecord.name).toBe("My Recipes");
    expect(boxRecord.owners).toContain(user.id);
    expect(boxRecord.visibility).toBe(Visibility.private);

    // Verify user's recipe_boxes was updated
    const userRecord = await ctx.pb.collection("users").getOne(user.id);
    expect(userRecord.recipe_boxes).toContain(result!.id);

    // Cleanup
    await ctx.pb.collection("recipe_boxes").delete(result!.id);
  });

  it("returns undefined when user is null", async () => {
    // addBox checks for null user at runtime — pass null cast as UserEntry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await addBox(null as any, "Should Not Create");
    expect(result).toBeUndefined();
  });
});

describe("deleteBox", () => {
  it("removes a recipe box via the app function", async () => {
    const user = await createTestUser(ctx);

    // Create box directly (not via TestCleanup since we'll delete it ourselves)
    const boxRecord = await ctx.pb.collection("recipe_boxes").create({
      name: "To Delete",
      owners: [user.id],
      visibility: "private",
    });

    const dispatchCalls: unknown[] = [];
    await deleteBox(boxRecord.id, (action) => { dispatchCalls.push(action); });

    expect(dispatchCalls).toHaveLength(1);
    expect((dispatchCalls[0] as { type: string }).type).toBe("REMOVE_BOX");

    await expect(ctx.pb.collection("recipe_boxes").getOne(boxRecord.id)).rejects.toThrow();
  });
});

describe("setBoxVisibility", () => {
  it("changes a box from private to public", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Vis Box", visibility: "private" });

    await setBoxVisibility(box.id, Visibility.public);

    const record = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(record.visibility).toBe(Visibility.public);

    await cleanup.cleanup();
  });

  it("changes a box from public back to private", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Pub Box", visibility: "public" });

    await setBoxVisibility(box.id, Visibility.private);

    const record = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(record.visibility).toBe(Visibility.private);

    await cleanup.cleanup();
  });
});

// ─── User ─────────────────────────────────────────────────────────────────────

describe("getUser", () => {
  it("returns a UserEntry for an existing user", async () => {
    const user = await createTestUser(ctx);
    const userEntry = await getUser(user.id);

    expect(userEntry).toBeDefined();
    expect(userEntry!.id).toBe(user.id);
  });

  it("returns undefined for a non-existent user", async () => {
    const result = await getUser("nonexistentid0000000");
    expect(result).toBeUndefined();
  });
});

// ─── Recipe Management ────────────────────────────────────────────────────────

describe("addRecipe", () => {
  it("creates a recipe in a box", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Recipe Box" });
    const userEntry = await getUser(user.id);

    const recipeEntry = new RecipeEntry(
      { "@type": "Recipe", name: "Chocolate Cake", recipeIngredient: ["2 cups flour", "1 cup cocoa"] },
      [user.id],
      Visibility.private,
      user.id,
      "placeholder",
      new Date(),
      new Date(),
      user.id,
    );

    const result = await addRecipe(box.id, recipeEntry);
    expect(result).toBeDefined();
    cleanup.track("recipes", result.id);

    const record = await ctx.pb.collection("recipes").getOne(result.id);
    expect(record.data.name).toBe("Chocolate Cake");
    expect(record.data.recipeIngredient).toHaveLength(2);
    expect(record.box).toBe(box.id);
    expect(record.owners).toContain(user.id);
    expect(record.enrichment_status).toBe(EnrichmentStatus.needed);

    await cleanup.cleanup();
  });

  it("creates a recipe with pending changes", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });

    const recipeEntry = new RecipeEntry(
      { "@type": "Recipe", name: "Pending Recipe" },
      [user.id],
      Visibility.private,
      user.id,
      "placeholder",
      new Date(),
      new Date(),
      user.id,
      {
        data: { name: "Enriched Name", description: "Enriched description" },
        source: "enrichment",
        reasoning: "test",
        generatedAt: new Date().toISOString(),
        model: "test-model",
      }
    );

    const result = await addRecipe(box.id, recipeEntry);
    cleanup.track("recipes", result.id);

    const record = await ctx.pb.collection("recipes").getOne(result.id);
    expect(record.pending_changes).toBeDefined();
    expect(record.pending_changes.source).toBe("enrichment");

    await cleanup.cleanup();
  });
});

describe("saveRecipe", () => {
  it("updates a recipe and resets enrichment status", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Original Name" });

    const recipeEntry = new RecipeEntry(
      { "@type": "Recipe", name: "Updated Name", description: "New description" },
      [user.id],
      Visibility.private,
      user.id,
      recipe.id,
      new Date(),
      new Date(),
      user.id,
      undefined, // pendingChanges — will be cleared by saveRecipe
    );
    recipeEntry.enrichmentStatus = EnrichmentStatus.done;

    const result = await saveRecipe(box.id, recipe.id, recipeEntry);
    expect(result.id).toBe(recipe.id);

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.data.name).toBe("Updated Name");
    expect(record.enrichment_status).toBe(EnrichmentStatus.needed);
    expect(record.pending_changes).toBeNull();

    await cleanup.cleanup();
  });
});

describe("deleteRecipe", () => {
  it("removes a recipe from PocketBase and dispatches REMOVE_RECIPE", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });

    // Create recipe directly so cleanup won't try to re-delete it
    const recipeRecord = await ctx.pb.collection("recipes").create({
      box: box.id,
      data: { name: "To Delete" },
      owners: [user.id],
      visibility: "private",
      creator: user.id,
    });

    const dispatched: unknown[] = [];
    const boxes = new Map();
    await deleteRecipe(boxes, box.id, recipeRecord.id, (action) => { dispatched.push(action); });

    expect(dispatched).toHaveLength(1);
    expect((dispatched[0] as { type: string }).type).toBe("REMOVE_RECIPE");

    await expect(ctx.pb.collection("recipes").getOne(recipeRecord.id)).rejects.toThrow();

    await cleanup.cleanup();
  });

  it("removes recipe from local box map without DB call for uniqueId= prefix IDs", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });

    // Build a boxes map with a locally-created recipe
    const { BoxEntry } = await import("../storage");
    const localRecipe = new RecipeEntry(
      { "@type": "Recipe", name: "Local" },
      [user.id],
      Visibility.private,
      user.id,
      "uniqueId=abc123",
      new Date(),
      new Date(),
      user.id,
    );
    const boxEntry = new BoxEntry(
      { name: "Box" },
      [user.id],
      Visibility.private,
      user.id,
      box.id,
      new Date(),
      new Date(),
      user.id,
    );
    boxEntry.recipes.set("uniqueId=abc123", localRecipe);
    const boxes = new Map([[box.id, boxEntry]]);

    const dispatched: unknown[] = [];
    await deleteRecipe(boxes, box.id, "uniqueId=abc123", (action) => { dispatched.push(action); });

    // No dispatch for local recipes
    expect(dispatched).toHaveLength(0);
    // Removed from the local map
    expect(boxEntry.recipes.has("uniqueId=abc123")).toBe(false);

    await cleanup.cleanup();
  });
});

describe("setRecipeVisibility", () => {
  it("updates a recipe's visibility to public", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "My Recipe", visibility: "private" });

    await setRecipeVisibility(box.id, recipe.id, Visibility.public);

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.visibility).toBe(Visibility.public);

    await cleanup.cleanup();
  });
});

// ─── Box Subscription ─────────────────────────────────────────────────────────

describe("subscribeToBox / unsubscribeFromBox", () => {
  it("adds user to box subscribers and user's recipe_boxes list", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);
    await signInAsUser(ctx, userA);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    // Both users need to be owners for subscribeToBox to work (PB update rules)
    const box = await createTestBox(ctx, cleanup, { name: "Shared Box", owners: [userA.id, userB.id] });

    // Sign in as userB — subscribeToBox is called by the subscribing user
    await signInAsUser(ctx, userB);
    const userBEntry = await getUser(userB.id);
    expect(userBEntry).toBeDefined();

    await subscribeToBox(userBEntry!, box.id);

    const boxRecord = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(boxRecord.subscribers).toContain(userB.id);

    const userBRecord = await ctx.pb.collection("users").getOne(userB.id);
    expect(userBRecord.recipe_boxes).toContain(box.id);

    await cleanup.cleanup();
  });

  it("removes user from box subscribers and user's recipe_boxes list", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);
    await signInAsUser(ctx, userA);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Shared Box", owners: [userA.id, userB.id] });

    // Sign in as userB for subscribe/unsubscribe
    await signInAsUser(ctx, userB);
    const userBEntry = await getUser(userB.id);
    await subscribeToBox(userBEntry!, box.id);

    // Verify subscription was added
    const beforeRecord = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(beforeRecord.subscribers).toContain(userB.id);

    await unsubscribeFromBox(userBEntry!, box.id);

    const boxRecord = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(boxRecord.subscribers).not.toContain(userB.id);

    const userBRecord = await ctx.pb.collection("users").getOne(userB.id);
    expect(userBRecord.recipe_boxes).not.toContain(box.id);

    await cleanup.cleanup();
  });

  it("does nothing when user is null", async () => {
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });

    // Should not throw
    await expect(subscribeToBox(null, box.id)).resolves.toBeUndefined();
    await expect(unsubscribeFromBox(null, box.id)).resolves.toBeUndefined();

    await cleanup.cleanup();
  });
});

// ─── Cooking Log Events ───────────────────────────────────────────────────────

describe("addCookingLogEvent / getCookingLogEvents", () => {
  it("adds a cooking log event and retrieves it", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Pasta" });

    const eventId = await addCookingLogEvent(box.id, recipe.id, user.id, "Great batch!");
    cleanup.track("recipe_events", eventId);

    const events = await getCookingLogEvents(box.id, recipe.id);
    expect(events.length).toBe(1);
    expect(events[0].data?.notes).toBe("Great batch!");

    await cleanup.cleanup();
  });

  it("adds multiple cooking log events", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Pizza" });

    const id1 = await addCookingLogEvent(box.id, recipe.id, user.id, "First time");
    const id2 = await addCookingLogEvent(box.id, recipe.id, user.id, "Second time");
    cleanup.track("recipe_events", id1);
    cleanup.track("recipe_events", id2);

    const events = await getCookingLogEvents(box.id, recipe.id);
    expect(events.length).toBe(2);

    await cleanup.cleanup();
  });

  it("returns empty array when no events exist", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Soup" });

    const events = await getCookingLogEvents(box.id, recipe.id);
    expect(events).toEqual([]);

    await cleanup.cleanup();
  });
});

describe("updateCookingLogEvent", () => {
  it("updates the notes on an event", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Stew" });

    const eventId = await addCookingLogEvent(box.id, recipe.id, user.id, "Original notes");
    cleanup.track("recipe_events", eventId);

    await updateCookingLogEvent(box.id, eventId, "Updated notes");

    const record = await ctx.pb.collection("recipe_events").getOne(eventId);
    expect(record.data.notes).toBe("Updated notes");

    await cleanup.cleanup();
  });

  it("removes notes when updated with empty string", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Stew" });

    const eventId = await addCookingLogEvent(box.id, recipe.id, user.id, "Some notes");
    cleanup.track("recipe_events", eventId);

    await updateCookingLogEvent(box.id, eventId, "   ");

    const record = await ctx.pb.collection("recipe_events").getOne(eventId);
    expect(record.data.notes).toBeUndefined();

    await cleanup.cleanup();
  });
});

describe("deleteCookingLogEvent", () => {
  it("removes a cooking log event", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Roast" });

    const eventId = await addCookingLogEvent(box.id, recipe.id, user.id);

    await deleteCookingLogEvent(box.id, eventId);

    await expect(ctx.pb.collection("recipe_events").getOne(eventId)).rejects.toThrow();

    await cleanup.cleanup();
  });
});

// ─── Pending Changes ──────────────────────────────────────────────────────────

describe("applyChanges", () => {
  it("applies enrichment changes to recipe data and sets status to done", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, {
      name: "Basic Soup",
      data: { recipeIngredient: ["water"] },
    });

    const changes = {
      data: {
        name: "Enriched Soup",
        description: "A rich, hearty soup",
        recipeIngredient: ["water", "1 onion", "2 carrots"],
      },
      source: "enrichment" as const,
      reasoning: "Added ingredients",
      generatedAt: new Date().toISOString(),
      model: "test-model",
    };

    await applyChanges(box.id, recipe.id, changes);

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.data.name).toBe("Enriched Soup");
    expect(record.data.description).toBe("A rich, hearty soup");
    expect(record.data.recipeIngredient).toHaveLength(3);
    expect(record.enrichment_status).toBe(EnrichmentStatus.done);
    expect(record.pending_changes).toBeNull();

    await cleanup.cleanup();
  });

  it("applies modification changes and re-queues enrichment", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Plain Chicken" });

    const changes = {
      data: {
        name: "Spiced Chicken",
        recipeInstructions: [{ "@type": "HowToStep" as const, text: "Season with spices" }],
      },
      source: "modification" as const,
      reasoning: "User requested spice",
      prompt: "add spices",
      generatedAt: new Date().toISOString(),
      model: "test-model",
    };

    await applyChanges(box.id, recipe.id, changes);

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.data.name).toBe("Spiced Chicken");
    expect(record.enrichment_status).toBe(EnrichmentStatus.needed);
    expect(record.pending_changes).toBeNull();

    await cleanup.cleanup();
  });

  it("merges tags from recipeCategory into existing tags", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Chicken Soup" });
    // Set initial tags via admin client
    await ctx.pb.collection("recipes").update(recipe.id, {
      data: { name: "Chicken Soup", recipeCategory: ["soup"] },
    });

    const changes = {
      data: {
        recipeCategory: ["dinner", "soup"],
      },
      source: "enrichment" as const,
      reasoning: "Added categories",
      generatedAt: new Date().toISOString(),
      model: "test-model",
    };

    await applyChanges(box.id, recipe.id, changes, { tags: ["soup"] });

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    // Tags merged and deduplicated
    expect(record.data.recipeCategory).toContain("soup");
    expect(record.data.recipeCategory).toContain("dinner");

    await cleanup.cleanup();
  });
});

describe("rejectChanges", () => {
  it("clears pending_changes without changing enrichment status for non-enrichment source", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Recipe" });

    // Add pending changes via admin
    await ctx.pb.collection("recipes").update(recipe.id, {
      pending_changes: {
        data: { name: "Proposed Name" },
        source: "modification",
        reasoning: "test",
        generatedAt: new Date().toISOString(),
        model: "test",
      },
    });

    await rejectChanges(box.id, recipe.id, "modification");

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.pending_changes).toBeNull();
    expect(record.enrichment_status).not.toBe(EnrichmentStatus.skipped);

    await cleanup.cleanup();
  });

  it("clears pending_changes and sets enrichment_status to skipped for enrichment source", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Recipe" });

    // Add pending enrichment changes via admin
    await ctx.pb.collection("recipes").update(recipe.id, {
      pending_changes: {
        data: { description: "Enriched description" },
        source: "enrichment",
        reasoning: "enrichment test",
        generatedAt: new Date().toISOString(),
        model: "test",
      },
    });

    await rejectChanges(box.id, recipe.id, "enrichment");

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.pending_changes).toBeNull();
    expect(record.enrichment_status).toBe(EnrichmentStatus.skipped);

    await cleanup.cleanup();
  });
});

// ─── getBox / getRecipes ───────────────────────────────────────────────────────

describe("getBox", () => {
  it("returns a BoxEntry with recipes", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Fetched Box" });
    await createTestRecipe(ctx, box.id, cleanup, { name: "Recipe A" });
    await createTestRecipe(ctx, box.id, cleanup, { name: "Recipe B" });

    const boxEntry = await getBox(box.id, user.id);
    expect(boxEntry).toBeDefined();
    expect(boxEntry!.data.name).toBe("Fetched Box");
    expect(boxEntry!.recipes.size).toBe(2);

    await cleanup.cleanup();
  });

  it("returns undefined for non-existent box", async () => {
    const result = await getBox("nonexistentboxid0000", null);
    expect(result).toBeUndefined();
  });
});

describe("getRecipes", () => {
  it("returns empty map when userId is null", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const boxEntry = await getBox(box.id, user.id);

    const recipes = await getRecipes(boxEntry!, null);
    expect(recipes.size).toBe(0);

    await cleanup.cleanup();
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe("User edge cases", () => {
  it("handles user with no recipe_boxes", async () => {
    const user = await createUserWithoutSignIn(ctx);
    await signInAsUser(ctx, user);

    const userEntry = await getUser(user.id);
    expect(userEntry).toBeDefined();
    expect(userEntry!.boxes.length).toBe(0);
  });

  it("handles stale box reference after box deletion", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const userEntry = await getUser(user.id);
    const result = await addBox(userEntry!, "Box To Delete");
    expect(result).toBeDefined();

    // Verify it's in user's list
    const beforeRecord = await ctx.pb.collection("users").getOne(user.id);
    expect(beforeRecord.recipe_boxes).toContain(result!.id);

    // Delete the box directly (bypassing deleteBox which dispatches)
    await ctx.pb.collection("recipe_boxes").delete(result!.id);

    // User doc still has stale reference
    const afterRecord = await ctx.pb.collection("users").getOne(user.id);
    expect(afterRecord.recipe_boxes).toContain(result!.id);

    // getBox returns undefined for deleted box
    const boxEntry = await getBox(result!.id, user.id);
    expect(boxEntry).toBeUndefined();

    await cleanup.cleanup();
  });
});

describe("Box access control", () => {
  it("prevents non-owner from deleting box via userPb", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);

    const box = await ctx.pb.collection("recipe_boxes").create({
      name: "Owner Only Box",
      owners: [userA.id],
      visibility: "private",
    });

    await signInAsUser(ctx, userB);
    await expect(
      ctx.userPb.collection("recipe_boxes").delete(box.id)
    ).rejects.toThrow();

    // Cleanup via admin
    await ctx.pb.collection("recipe_boxes").delete(box.id);
  });
});
