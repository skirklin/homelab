/**
 * End-to-end tests for Recipes app using the @homelab/backend interface.
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
import { PocketBaseRecipesBackend } from "@homelab/backend/pocketbase";
import { RecipeEntry } from "../storage";
import { EnrichmentStatus, Visibility } from "../types";

let ctx: TestContext;
let recipes: PocketBaseRecipesBackend;

beforeAll(async () => {
  ctx = await initTestPocketBase();
  recipes = new PocketBaseRecipesBackend(() => ctx.userPb);
});

afterAll(async () => {
  await cleanupTestPocketBase(ctx);
});

// ─── Box Management ──────────────────────────────────────────────────────────

describe("createBox", () => {
  it("creates a recipe box and links it to the user", async () => {
    const user = await createTestUser(ctx);

    const boxId = await recipes.createBox(user.id, "My Recipes");
    expect(boxId).toBeTruthy();

    // Verify via admin client
    const boxRecord = await ctx.pb.collection("recipe_boxes").getOne(boxId);
    expect(boxRecord.name).toBe("My Recipes");
    expect(boxRecord.owners).toContain(user.id);
    expect(boxRecord.visibility).toBe(Visibility.private);

    // Verify user's recipe_boxes was updated
    const userRecord = await ctx.pb.collection("users").getOne(user.id);
    expect(userRecord.recipe_boxes).toContain(boxId);

    // Cleanup
    await ctx.pb.collection("recipe_boxes").delete(boxId);
  });
});

describe("deleteBox", () => {
  it("removes a recipe box via the backend", async () => {
    const user = await createTestUser(ctx);

    // Create box directly (not via TestCleanup since we'll delete it ourselves)
    const boxRecord = await ctx.pb.collection("recipe_boxes").create({
      name: "To Delete",
      owners: [user.id],
      visibility: "private",
    });

    await recipes.deleteBox(boxRecord.id);

    await expect(ctx.pb.collection("recipe_boxes").getOne(boxRecord.id)).rejects.toThrow();
  });
});

describe("setBoxVisibility", () => {
  it("changes a box from private to public", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Vis Box", visibility: "private" });

    await recipes.setBoxVisibility(box.id, Visibility.public);

    const record = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(record.visibility).toBe(Visibility.public);

    await cleanup.cleanup();
  });

  it("changes a box from public back to private", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Pub Box", visibility: "public" });

    await recipes.setBoxVisibility(box.id, Visibility.private);

    const record = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(record.visibility).toBe(Visibility.private);

    await cleanup.cleanup();
  });
});

// ─── User ─────────────────────────────────────────────────────────────────────

describe("getUser", () => {
  it("returns a user for an existing user", async () => {
    const user = await createTestUser(ctx);
    const userEntry = await recipes.getUser(user.id);

    expect(userEntry).not.toBeNull();
    expect(userEntry!.id).toBe(user.id);
  });

  it("returns null for a non-existent user", async () => {
    const result = await recipes.getUser("nonexistentid0000000");
    expect(result).toBeNull();
  });
});

// ─── Recipe Management ────────────────────────────────────────────────────────

describe("addRecipe", () => {
  it("creates a recipe in a box", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Recipe Box" });

    const recipeId = await recipes.addRecipe(box.id, {
      "@type": "Recipe",
      name: "Chocolate Cake",
      recipeIngredient: ["2 cups flour", "1 cup cocoa"],
    }, user.id);
    expect(recipeId).toBeTruthy();
    cleanup.track("recipes", recipeId);

    const record = await ctx.pb.collection("recipes").getOne(recipeId);
    expect(record.data.name).toBe("Chocolate Cake");
    expect(record.data.recipeIngredient).toHaveLength(2);
    expect(record.box).toBe(box.id);
    expect(record.owners).toContain(user.id);
    expect(record.enrichment_status).toBe(EnrichmentStatus.needed);

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

    await recipes.saveRecipe(recipe.id, {
      "@type": "Recipe",
      name: "Updated Name",
      description: "New description",
    }, user.id);

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.data.name).toBe("Updated Name");
    expect(record.enrichment_status).toBe(EnrichmentStatus.needed);
    expect(record.pending_changes).toBeNull();

    await cleanup.cleanup();
  });
});

describe("deleteRecipe", () => {
  it("removes a recipe from PocketBase", async () => {
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

    await recipes.deleteRecipe(recipeRecord.id);

    await expect(ctx.pb.collection("recipes").getOne(recipeRecord.id)).rejects.toThrow();

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

    await recipes.setRecipeVisibility(recipe.id, Visibility.public);

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

    await recipes.subscribeToBox(userB.id, box.id);

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
    await recipes.subscribeToBox(userB.id, box.id);

    // Verify subscription was added
    const beforeRecord = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(beforeRecord.subscribers).toContain(userB.id);

    await recipes.unsubscribeFromBox(userB.id, box.id);

    const boxRecord = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(boxRecord.subscribers).not.toContain(userB.id);

    const userBRecord = await ctx.pb.collection("users").getOne(userB.id);
    expect(userBRecord.recipe_boxes).not.toContain(box.id);

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

    const eventId = await recipes.addCookingLogEvent(box.id, recipe.id, user.id, { notes: "Great batch!" });
    cleanup.track("recipe_events", eventId);

    const events = await recipes.getCookingLogEvents(box.id, recipe.id);
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

    const id1 = await recipes.addCookingLogEvent(box.id, recipe.id, user.id, { notes: "First time" });
    const id2 = await recipes.addCookingLogEvent(box.id, recipe.id, user.id, { notes: "Second time" });
    cleanup.track("recipe_events", id1);
    cleanup.track("recipe_events", id2);

    const events = await recipes.getCookingLogEvents(box.id, recipe.id);
    expect(events.length).toBe(2);

    await cleanup.cleanup();
  });

  it("returns empty array when no events exist", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Soup" });

    const events = await recipes.getCookingLogEvents(box.id, recipe.id);
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

    const eventId = await recipes.addCookingLogEvent(box.id, recipe.id, user.id, { notes: "Original notes" });
    cleanup.track("recipe_events", eventId);

    await recipes.updateCookingLogEvent(eventId, "Updated notes");

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

    const eventId = await recipes.addCookingLogEvent(box.id, recipe.id, user.id, { notes: "Some notes" });
    cleanup.track("recipe_events", eventId);

    await recipes.updateCookingLogEvent(eventId, "   ");

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

    const eventId = await recipes.addCookingLogEvent(box.id, recipe.id, user.id);

    await recipes.deleteCookingLogEvent(eventId);

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

    await recipes.applyChanges(recipe.id, changes);

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

    await recipes.applyChanges(recipe.id, changes);

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

    await recipes.applyChanges(recipe.id, changes, { tags: ["soup"] });

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

    await recipes.rejectChanges(recipe.id, "modification");

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

    await recipes.rejectChanges(recipe.id, "enrichment");

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.pending_changes).toBeNull();
    expect(record.enrichment_status).toBe(EnrichmentStatus.skipped);

    await cleanup.cleanup();
  });
});

// ─── getBox ───────────────────────────────────────────────────────────────────

describe("getBox", () => {
  it("returns a box with recipes", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Fetched Box" });
    await createTestRecipe(ctx, box.id, cleanup, { name: "Recipe A" });
    await createTestRecipe(ctx, box.id, cleanup, { name: "Recipe B" });

    const result = await recipes.getBox(box.id, user.id);
    expect(result).not.toBeNull();
    expect(result!.box.name).toBe("Fetched Box");
    expect(result!.recipes.length).toBe(2);

    await cleanup.cleanup();
  });

  it("returns null for non-existent box", async () => {
    const result = await recipes.getBox("nonexistentboxid0000", null);
    expect(result).toBeNull();
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe("User edge cases", () => {
  it("handles user with no recipe_boxes", async () => {
    const user = await createUserWithoutSignIn(ctx);
    await signInAsUser(ctx, user);

    const userEntry = await recipes.getUser(user.id);
    expect(userEntry).not.toBeNull();
    expect(userEntry!.boxes.length).toBe(0);
  });

  it("handles stale box reference after box deletion", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const boxId = await recipes.createBox(user.id, "Box To Delete");
    expect(boxId).toBeTruthy();

    // Verify it's in user's list
    const beforeRecord = await ctx.pb.collection("users").getOne(user.id);
    expect(beforeRecord.recipe_boxes).toContain(boxId);

    // Delete the box directly (bypassing deleteBox)
    await ctx.pb.collection("recipe_boxes").delete(boxId);

    // User doc still has stale reference
    const afterRecord = await ctx.pb.collection("users").getOne(user.id);
    expect(afterRecord.recipe_boxes).toContain(boxId);

    // getBox returns null for deleted box
    const result = await recipes.getBox(boxId, user.id);
    expect(result).toBeNull();

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

// ─── Sharing Invites ─────────────────────────────────────────────────────────

describe("Sharing invites", () => {
  it("owner can create an invite for their box", async () => {
    const userA = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Invite Box" });

    // Create invite as the owner (userA is signed in)
    const invite = await ctx.userPb.collection("sharing_invites").create({
      code: `test-${Date.now()}`,
      target_type: "box",
      target_id: box.id,
      created_by: userA.id,
      redeemed: false,
    });
    cleanup.track("sharing_invites", invite.id);

    expect(invite.code).toBeTruthy();
    expect(invite.target_type).toBe("box");
    expect(invite.target_id).toBe(box.id);

    await cleanup.cleanup();
  });

  it("non-owner cannot create an invite (hook blocks it)", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);

    const box = await ctx.pb.collection("recipe_boxes").create({
      name: "Not My Box",
      owners: [userA.id],
      visibility: "private",
    });

    // Sign in as userB (not an owner)
    await signInAsUser(ctx, userB);
    await expect(
      ctx.userPb.collection("sharing_invites").create({
        code: `test-${Date.now()}`,
        target_type: "box",
        target_id: box.id,
        created_by: userB.id,
        redeemed: false,
      })
    ).rejects.toThrow();

    // Cleanup
    await ctx.pb.collection("recipe_boxes").delete(box.id);
  });

  it("redeem invite adds user to box owners", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);

    // Create box as userA
    const box = await ctx.pb.collection("recipe_boxes").create({
      name: "Shared Box",
      owners: [userA.id],
      visibility: "private",
    });

    // Create invite as userA (who owns the box)
    await signInAsUser(ctx, userA);
    const code = `invite-${Date.now()}`;
    const invite = await ctx.userPb.collection("sharing_invites").create({
      code,
      target_type: "box",
      target_id: box.id,
      created_by: userA.id,
      redeemed: false,
    });

    // Sign in as userB and redeem via the custom hook endpoint
    await signInAsUser(ctx, userB);
    const response = await ctx.userPb.send("/api/sharing/redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.success).toBe(true);

    // Verify userB is now an owner
    const updatedBox = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(updatedBox.owners).toContain(userB.id);

    // Verify invite is marked redeemed
    const updatedInvite = await ctx.pb.collection("sharing_invites").getOne(invite.id);
    expect(updatedInvite.redeemed).toBe(true);
    expect(updatedInvite.redeemed_by).toBe(userB.id);

    // Cleanup
    await ctx.pb.collection("sharing_invites").delete(invite.id);
    await ctx.pb.collection("recipe_boxes").delete(box.id);
  });

  it("cannot redeem an already-redeemed invite", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);

    const box = await ctx.pb.collection("recipe_boxes").create({
      name: "Once Only Box",
      owners: [userA.id],
      visibility: "private",
    });

    // Create invite as userA (owner), then mark as redeemed via admin
    await signInAsUser(ctx, userA);
    const code = `once-${Date.now()}`;
    const invite = await ctx.userPb.collection("sharing_invites").create({
      code,
      target_type: "box",
      target_id: box.id,
      created_by: userA.id,
      redeemed: false,
    });
    // Mark as redeemed via admin
    await ctx.pb.collection("sharing_invites").update(invite.id, { redeemed: true });

    await signInAsUser(ctx, userB);
    await expect(
      ctx.userPb.send("/api/sharing/redeem", {
        method: "POST",
        body: JSON.stringify({ code }),
        headers: { "Content-Type": "application/json" },
      })
    ).rejects.toThrow();

    // Cleanup
    await ctx.pb.collection("sharing_invites").delete(invite.id);
    await ctx.pb.collection("recipe_boxes").delete(box.id);
  });
});
