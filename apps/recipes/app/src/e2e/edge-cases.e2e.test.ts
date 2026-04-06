/**
 * Edge case and corner case tests for Recipes app
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  initTestFirebase,
  createUserWithoutSignIn,
  signInAsUser,
  cleanupTestFirebase,
  TestCleanup,
  createTestBox,
  createTestRecipe,
  createTestRecipesUser,
  type TestContext,
} from "@kirkl/shared";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  updateDoc,
  arrayRemove,
  Timestamp,
} from "firebase/firestore";

let ctx: TestContext;
let cleanup: TestCleanup;

describe("Recipes Edge Cases", () => {
  beforeAll(async () => {
    ctx = await initTestFirebase();
    cleanup = new TestCleanup();
  });

  afterAll(async () => {
    await cleanupTestFirebase(ctx);
  });

  afterEach(async () => {
    await cleanup.cleanup();
  });

  describe("User Document Edge Cases", () => {
    it("should handle user with no boxes array", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // Create user doc WITHOUT boxes field (simulates cross-app user)
      const userRef = doc(ctx.db, "users", user.localId);
      cleanup.track(userRef);
      await setDoc(userRef, {
        name: "Cross-app User",
        // No boxes field - this is what caused the original bug
        createdAt: Timestamp.now(),
      });

      const userSnap = await getDoc(userRef);
      expect(userSnap.exists()).toBe(true);
      expect(userSnap.data()?.boxes).toBeUndefined();
    });

    it("should handle user with empty boxes array", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      await createTestRecipesUser(ctx, cleanup, []);

      const userRef = doc(ctx.db, "users", user.localId);
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toEqual([]);
    });

    it("should handle user with box reference to deleted box", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      await createTestRecipesUser(ctx, cleanup, [boxRef.id]);

      // Delete the box
      await deleteDoc(boxRef);

      // User still has reference to deleted box
      const userRef = doc(ctx.db, "users", user.localId);
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toHaveLength(1);

      // But the box doesn't exist
      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.exists()).toBe(false);
    });
  });

  describe("Box Edge Cases", () => {
    it("should handle box with no recipes", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });

      const recipes = await getDocs(collection(ctx.db, "boxes", boxRef.id, "recipes"));
      expect(recipes.empty).toBe(true);
    });

    it("should handle box with empty owners (orphaned)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // Create box directly without cleanup tracking (will become orphaned)
      const boxRef = doc(ctx.db, "boxes", `orphan-box-${Date.now()}`);
      await setDoc(boxRef, {
        data: { name: "Orphan Box" },
        owners: [user.localId],
        visibility: "private",
        creator: user.localId,
        created: Timestamp.now(),
        updated: Timestamp.now(),
        lastUpdatedBy: user.localId,
      });

      // Remove all owners
      await updateDoc(boxRef, { owners: [] });

      // User can no longer read the box (not an owner)
      await expect(getDoc(boxRef)).rejects.toThrow();

      // Box is now orphaned - can't be accessed or cleaned up by this user
    });

    it("should handle deleting box that user still references", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      await createTestRecipesUser(ctx, cleanup, [boxRef.id]);

      // User A deletes the box
      await deleteDoc(boxRef);

      // User doc still has the stale reference
      const userRef = doc(ctx.db, "users", user.localId);
      const userSnap = await getDoc(userRef);
      const boxIds = userSnap.data()?.boxes.map((b: any) => b.id);
      expect(boxIds).toContain(boxRef.id);
    });
  });

  describe("Recipe Edge Cases", () => {
    it("should handle recipe with empty name", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "",
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.data.name).toBe("");
    });

    it("should handle recipe with no ingredients", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "No Ingredients",
        ingredients: [],
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.data.recipeIngredient).toEqual([]);
    });

    it("should handle recipe with no instructions", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "No Instructions",
        instructions: [],
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.data.recipeInstructions).toEqual([]);
    });

    it("should handle very long recipe name", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      const longName = "A".repeat(10000);
      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: longName,
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.data.name.length).toBe(10000);
    });
  });

  describe("Multi-user Conflict Scenarios", () => {
    it("should handle User A removing User B from box while B has recipes", async () => {
      const userA = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, userA);

      const boxRef = await createTestBox(ctx, cleanup, { owners: [userA.localId] });

      // Add User B
      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(boxRef, { owners: [userA.localId, userB.localId] });

      // User B adds a recipe
      await signInAsUser(ctx, userB);
      await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "User B's Recipe",
        owners: [userB.localId],
      });

      // User A removes User B
      await signInAsUser(ctx, userA);
      await updateDoc(boxRef, { owners: arrayRemove(userB.localId) });

      // Verify User B is removed from box owners
      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.data()?.owners).not.toContain(userB.localId);

      // Recipe still exists (owned by User B)
      const recipes = await getDocs(collection(ctx.db, "boxes", boxRef.id, "recipes"));
      expect(recipes.size).toBe(1);
    });

    it("should handle both users adding recipes simultaneously", async () => {
      const userA = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, userA);

      const boxRef = await createTestBox(ctx, cleanup, { owners: [userA.localId] });

      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(boxRef, { owners: [userA.localId, userB.localId] });

      // User A adds recipe
      await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "User A's Recipe",
        owners: [userA.localId],
      });

      // User B adds recipe
      await signInAsUser(ctx, userB);
      await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "User B's Recipe",
        owners: [userB.localId],
      });

      // Both recipes exist
      const recipes = await getDocs(collection(ctx.db, "boxes", boxRef.id, "recipes"));
      expect(recipes.size).toBe(2);
    });

    it("should handle user deleting box while another user has it", async () => {
      const userA = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, userA);

      const boxRef = await createTestBox(ctx, cleanup, { owners: [userA.localId] });
      await createTestRecipesUser(ctx, cleanup, [boxRef.id]);

      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(boxRef, { owners: [userA.localId, userB.localId] });

      await signInAsUser(ctx, userB);
      await createTestRecipesUser(ctx, cleanup, [boxRef.id]);

      // User B adds a recipe
      await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "User B's Recipe",
        owners: [userB.localId],
      });

      // User A deletes the box
      await signInAsUser(ctx, userA);
      await deleteDoc(boxRef);

      // User A can verify box is gone (they still have the ref)
      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.exists()).toBe(false);

      // User B still has stale reference in their user doc
      await signInAsUser(ctx, userB);
      const userBDoc = await getDoc(doc(ctx.db, "users", userB.localId));
      expect(userBDoc.data()?.boxes.map((b: any) => b.id)).toContain(boxRef.id);

      // But the box itself is deleted
      const boxSnapB = await getDoc(boxRef);
      expect(boxSnapB.exists()).toBe(false);
    });
  });

  describe("Visibility Edge Cases", () => {
    it("should handle changing visibility from private to public", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const boxRef = await createTestBox(ctx, cleanup, {
        owners: [user.localId],
        visibility: "private",
      });

      await updateDoc(boxRef, { visibility: "public" });

      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.data()?.visibility).toBe("public");
    });

    it("should handle recipe with different visibility than box", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const boxRef = await createTestBox(ctx, cleanup, {
        owners: [user.localId],
        visibility: "private",
      });

      const recipeRef = await createTestRecipe(ctx, boxRef.id, cleanup, {
        name: "Public in Private Box",
        visibility: "public",
      });

      const recipeSnap = await getDoc(recipeRef);
      expect(recipeSnap.data()?.visibility).toBe("public");

      const boxSnap = await getDoc(boxRef);
      expect(boxSnap.data()?.visibility).toBe("private");
    });
  });
});
