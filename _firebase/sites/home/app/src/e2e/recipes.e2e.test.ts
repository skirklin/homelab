/**
 * E2E tests for Recipes module within the Home app
 *
 * Tests the recipes functionality when embedded in the combined home app.
 * Verifies that recipes operations work correctly in the integrated context.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  initTestFirebase,
  createTestUser,
  createUserWithoutSignIn,
  signInAsUser,
  cleanupTestFirebase,
  TestCleanup,
  createTestBox,
  createTestRecipe,
  createTestRecipesUser,
  addBoxToUser,
  type TestContext,
} from "@kirkl/shared";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove,
  Timestamp,
} from "firebase/firestore";

let ctx: TestContext;
let cleanup: TestCleanup;

describe("Recipes Module in Home App", () => {
  beforeAll(async () => {
    ctx = await initTestFirebase();
    await createTestUser(ctx);
    cleanup = new TestCleanup();
  });

  afterAll(async () => {
    await cleanupTestFirebase(ctx);
  });

  afterEach(async () => {
    await cleanup.cleanup();
  });

  describe("Box CRUD Operations", () => {
    it("should create a recipe box", async () => {
      const boxRef = await createTestBox(ctx, cleanup, {
        name: "Home App Recipes",
      });

      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.exists()).toBe(true);
      expect(boxSnap.data()?.data.name).toBe("Home App Recipes");
      expect(boxSnap.data()?.owners).toContain(ctx.testUser!.uid);
    });

    it("should update box name", async () => {
      const boxRef = await createTestBox(ctx, cleanup, {
        name: "Original Name",
      });

      await updateDoc(boxRef, {
        "data.name": "Updated Name",
        updated: Timestamp.now(),
      });

      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.data()?.data.name).toBe("Updated Name");
    });

    it("should delete a box", async () => {
      const boxRef = await createTestBox(ctx, cleanup);

      await deleteDoc(boxRef);

      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.exists()).toBe(false);
    });
  });

  describe("Recipe CRUD Operations", () => {
    it("should create a recipe with full details", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Spaghetti Carbonara",
        description: "Classic Italian pasta dish",
        ingredients: ["400g spaghetti", "200g pancetta", "4 eggs", "100g parmesan"],
        instructions: [
          "Cook pasta in salted water",
          "Fry pancetta until crispy",
          "Mix eggs with parmesan",
          "Combine all ingredients",
        ],
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.exists()).toBe(true);
      expect(recipeSnap.data()?.data.name).toBe("Spaghetti Carbonara");
      expect(recipeSnap.data()?.data.recipeIngredient).toHaveLength(4);
      expect(recipeSnap.data()?.data.recipeInstructions).toHaveLength(4);
    });

    it("should update a recipe", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Original Recipe",
      });

      await updateDoc(recipeRef, {
        "data.name": "Updated Recipe",
        "data.description": "New description",
        updated: Timestamp.now(),
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.data.name).toBe("Updated Recipe");
      expect(recipeSnap.data()?.data.description).toBe("New description");
    });

    it("should delete a recipe", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "To Delete",
      });

      await deleteDoc(recipeRef);

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.exists()).toBe(false);
    });

    it("should list all recipes in a box", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      await createTestRecipe(ctx, boxRef.id, cleanup, { name: "Recipe A" });
      await createTestRecipe(ctx, boxRef.id, cleanup, { name: "Recipe B" });
      await createTestRecipe(ctx, boxRef.id, cleanup, { name: "Recipe C" });
      await createTestRecipe(ctx, boxRef.id, cleanup, { name: "Recipe D" });

      const recipesRef = collection(ctx.db, "boxes", boxRef.id, "recipes");
      const recipes = await getDocs(recipesRef);
      expect(recipes.size).toBe(4);
    });
  });

  describe("User Box Management", () => {
    it("should create a user with boxes", async () => {
      const box1 = await createTestBox(ctx, cleanup, { name: "Box 1" });
      const box2 = await createTestBox(ctx, cleanup, { name: "Box 2" });
      await createTestRecipesUser(ctx, cleanup, [box1.id, box2.id]);

      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toHaveLength(2);
    });

    it("should add a box to existing user", async () => {
      await createTestRecipesUser(ctx, cleanup, []);
      const boxRef = await createTestBox(ctx, cleanup, { name: "New Box" });

      await addBoxToUser(ctx, ctx.testUser!.uid, boxRef.id);

      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toHaveLength(1);
    });

    it("should remove a box from user", async () => {
      const box1 = await createTestBox(ctx, cleanup, { name: "Keep" });
      const box2 = await createTestBox(ctx, cleanup, { name: "Remove" });
      await createTestRecipesUser(ctx, cleanup, [box1.id, box2.id]);

      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      const box2Ref = doc(ctx.db, "boxes", box2.id);

      await updateDoc(userRef, {
        boxes: arrayRemove(box2Ref),
      });

      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toHaveLength(1);
    });
  });

  describe("Multi-user Box Sharing", () => {
    it("should share a box between users", async () => {
      const user1 = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user1);

      const boxRef = await createTestBox(ctx, cleanup, {
        name: "Shared Recipes",
        owners: [user1.localId],
      });

      // Add second user
      const user2 = await createUserWithoutSignIn(ctx);
      await updateDoc(boxRef, { owners: arrayUnion(user2.localId) });

      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.data()?.owners).toContain(user1.localId);
      expect(boxSnap.data()?.owners).toContain(user2.localId);
    });

    it("should allow shared user to add recipes", async () => {
      const user1 = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user1);

      const boxRef = await createTestBox(ctx, cleanup, {
        name: "Collaborative Box",
        owners: [user1.localId],
      });

      // Add user2 to owners
      const user2 = await createUserWithoutSignIn(ctx);
      await updateDoc(boxRef, { owners: arrayUnion(user2.localId) });

      // User2 adds a recipe
      await signInAsUser(ctx, user2);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "User 2's Recipe",
        owners: [user2.localId],
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.creator).toBe(user2.localId);
    });

    it("should allow shared user to edit recipes", async () => {
      const user1 = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user1);

      const boxRef = await createTestBox(ctx, cleanup, {
        owners: [user1.localId],
      });
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Original",
        owners: [user1.localId],
      });

      // Add user2 and have them edit
      const user2 = await createUserWithoutSignIn(ctx);
      await updateDoc(boxRef, { owners: arrayUnion(user2.localId) });
      await updateDoc(recipeRef, { owners: arrayUnion(user2.localId) });

      await signInAsUser(ctx, user2);
      await updateDoc(recipeRef, {
        "data.name": "Edited by User 2",
        updated: Timestamp.now(),
        lastEditor: user2.localId,
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.data.name).toBe("Edited by User 2");
    });

    it("should remove user from box", async () => {
      const user1 = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user1);

      const boxRef = await createTestBox(ctx, cleanup, {
        owners: [user1.localId],
      });

      const user2 = await createUserWithoutSignIn(ctx);
      await updateDoc(boxRef, { owners: arrayUnion(user2.localId) });

      // Remove user2
      await updateDoc(boxRef, { owners: arrayRemove(user2.localId) });

      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.data()?.owners).toContain(user1.localId);
      expect(boxSnap.data()?.owners).not.toContain(user2.localId);
    });
  });

  describe("Recipe Visibility", () => {
    it("should create private recipes by default", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Private Recipe",
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.visibility).toBe("private");
    });

    it("should create public recipes", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Public Recipe",
        visibility: "public",
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.visibility).toBe("public");
    });

    it("should change recipe visibility", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Changing Visibility",
        visibility: "private",
      });

      await updateDoc(recipeRef, { visibility: "public" });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.visibility).toBe("public");
    });
  });

  describe("Cooking Log", () => {
    it("should record when a recipe was cooked", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Cooked Recipe",
      });

      // Record cooking
      const logRef = doc(collection(ctx.db, "boxes", boxRef.id, "recipes", recipeRef.id, "cookingLog"));
      cleanup.track(logRef);
      await setDoc(logRef, {
        cookedAt: Timestamp.now(),
        cookedBy: ctx.testUser!.uid,
        notes: "Turned out great!",
        rating: 5,
      });

      const logSnap = await getDoc(logRef);
      expect(logSnap.exists()).toBe(true);
      expect(logSnap.data()?.rating).toBe(5);
    });

    it("should retrieve cooking history", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Frequently Cooked",
      });

      // Record multiple cookings
      for (let i = 0; i < 5; i++) {
        const logRef = doc(collection(ctx.db, "boxes", boxRef.id, "recipes", recipeRef.id, "cookingLog"));
        cleanup.track(logRef);
        await setDoc(logRef, {
          cookedAt: Timestamp.now(),
          cookedBy: ctx.testUser!.uid,
        });
      }

      const logRef = collection(ctx.db, "boxes", boxRef.id, "recipes", recipeRef.id, "cookingLog");
      const logs = await getDocs(logRef);
      expect(logs.size).toBe(5);
    });
  });

  describe("Recipe Tags", () => {
    it("should add tags to a recipe", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Tagged Recipe",
      });

      await updateDoc(recipeRef, {
        "data.keywords": ["italian", "pasta", "quick", "weeknight"],
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.data.keywords).toContain("italian");
      expect(recipeSnap.data()?.data.keywords).toHaveLength(4);
    });
  });
});
