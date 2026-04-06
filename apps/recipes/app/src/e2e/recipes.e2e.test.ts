/**
 * End-to-end tests for Recipes app using Firebase emulators
 *
 * Run with: npm test -- --run src/e2e
 * Requires Firebase emulators running: firebase emulators:start
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
  updateDoc,
  arrayUnion,
  Timestamp,
} from "firebase/firestore";

let ctx: TestContext;
let cleanup: TestCleanup;

describe("Recipes E2E Tests", () => {
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

  describe("Box Management", () => {
    it("should create a recipe box", async () => {
      const boxRef = await createTestBox(ctx, cleanup, {
        name: "My Recipes",
      });

      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.exists()).toBe(true);
      expect(boxSnap.data()?.data.name).toBe("My Recipes");
      expect(boxSnap.data()?.owners).toContain(ctx.testUser!.uid);
    });

    it("should create a user with boxes", async () => {
      const boxRef = await createTestBox(ctx, cleanup, { name: "Family Recipes" });
      await createTestRecipesUser(ctx, cleanup, [boxRef.id]);

      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      const userSnap = await getDoc(userRef);
      expect(userSnap.exists()).toBe(true);
      expect(userSnap.data()?.boxes).toHaveLength(1);
    });

    it("should add a box to user", async () => {
      await createTestRecipesUser(ctx, cleanup, []);
      const boxRef = await createTestBox(ctx, cleanup, { name: "New Box" });

      await addBoxToUser(ctx, ctx.testUser!.uid, boxRef.id);

      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toHaveLength(1);
    });
  });

  describe("Recipe Management", () => {
    it("should create a recipe in a box", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Chocolate Cake",
        description: "A delicious chocolate cake",
        ingredients: ["2 cups flour", "1 cup sugar", "1/2 cup cocoa"],
        instructions: ["Mix dry ingredients", "Add wet ingredients", "Bake at 350F"],
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.exists()).toBe(true);
      expect(recipeSnap.data()?.data.name).toBe("Chocolate Cake");
      expect(recipeSnap.data()?.data.recipeIngredient).toHaveLength(3);
    });

    it("should list recipes in a box", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      await createTestRecipe(ctx, boxRef.id, cleanup, { name: "Recipe 1" });
      await createTestRecipe(ctx, boxRef.id, cleanup, { name: "Recipe 2" });
      await createTestRecipe(ctx, boxRef.id, cleanup, { name: "Recipe 3" });

      const recipesRef = collection(ctx.db, "boxes", boxRef.id, "recipes");
      const recipes = await getDocs(recipesRef);
      expect(recipes.size).toBe(3);
    });

    it("should update a recipe", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Original Name",
      });

      await updateDoc(recipeRef, {
        "data.name": "Updated Name",
        updated: Timestamp.now(),
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.data.name).toBe("Updated Name");
    });

    it("should delete a recipe", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "To Delete",
      });

      const { deleteDoc } = await import("firebase/firestore");
      await deleteDoc(recipeRef);

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.exists()).toBe(false);
    });
  });

  describe("Multi-user Box Sharing", () => {
    it("should share a box between users", async () => {
      const userA = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, userA);

      const boxRef = await createTestBox(ctx, cleanup, {
        name: "Shared Recipes",
        owners: [userA.localId],
      });

      // Add User B
      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(boxRef, { owners: arrayUnion(userB.localId) });

      // Verify both users are owners
      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.data()?.owners).toContain(userA.localId);
      expect(boxSnap.data()?.owners).toContain(userB.localId);

      // User B can add recipes
      await signInAsUser(ctx, userB);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "User B's Recipe",
        owners: [userB.localId],
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.creator).toBe(userB.localId);
    });

    it("should allow multiple users to have the same box", async () => {
      const userA = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, userA);

      const boxRef = await createTestBox(ctx, cleanup, {
        name: "Family Recipes",
        owners: [userA.localId],
      });
      await createTestRecipesUser(ctx, cleanup, [boxRef.id]);

      // User B subscribes to the box
      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(boxRef, { owners: arrayUnion(userB.localId) });

      await signInAsUser(ctx, userB);
      await createTestRecipesUser(ctx, cleanup, [boxRef.id]);

      // User B can read their own user doc and see the box
      const userBDoc = await getDoc(doc(ctx.db, "users", userB.localId));
      expect(userBDoc.data()?.boxes.map((b: any) => b.id)).toContain(boxRef.id);

      // User B can read the shared box
      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.data()?.owners).toContain(userA.localId);
      expect(boxSnap.data()?.owners).toContain(userB.localId);
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

    it("should allow public recipes", async () => {
      const boxRef = await createTestBox(ctx, cleanup);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Public Recipe",
        visibility: "public",
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.visibility).toBe("public");
    });
  });
});
