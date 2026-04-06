/**
 * Integration tests for the combined Home app
 *
 * These tests verify that users created by one app module can
 * access other app modules without errors (cross-app compatibility).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  initTestFirebase,
  createUserWithoutSignIn,
  signInAsUser,
  cleanupTestFirebase,
  TestCleanup,
  // Groceries helpers
  createTestList,
  createTestItem,
  // Upkeep helpers
  createTestTaskList,
  createTestTask,
  // Life tracker helpers
  createTestLifeLog,
  createTestEntry,
  // Recipes helpers
  createTestBox,
  createTestRecipe,
  createTestRecipesUser,
  type TestContext,
} from "@kirkl/shared";
import {
  doc,
  getDoc,
  setDoc,
  Timestamp,
} from "firebase/firestore";

let ctx: TestContext;
let cleanup: TestCleanup;

describe("Home App Integration Tests", () => {
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

  describe("Cross-App User Document Compatibility", () => {
    it("should handle groceries user accessing recipes (no boxes field)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // User created via groceries - has slugs but no boxes
      const userRef = doc(ctx.db, "users", user.localId);
      cleanup.track(userRef);
      await setDoc(userRef, {
        slugs: { groceries: "list-123" },
        createdAt: Timestamp.now(),
      });

      // Verify user doc has no boxes field
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toBeUndefined();
      expect(userSnap.data()?.slugs?.groceries).toBe("list-123");

      // User should be able to create a box for recipes
      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      expect((await getDoc(boxRef)).exists()).toBe(true);
    });

    it("should handle upkeep user accessing recipes (no boxes field)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // User created via upkeep - has householdSlugs but no boxes
      const userRef = doc(ctx.db, "users", user.localId);
      cleanup.track(userRef);
      await setDoc(userRef, {
        householdSlugs: { home: "tasklist-123" },
        createdAt: Timestamp.now(),
      });

      // Verify user doc structure
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toBeUndefined();
      expect(userSnap.data()?.householdSlugs?.home).toBe("tasklist-123");

      // User should be able to use recipes
      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      await createTestRecipe(ctx, boxRef.id, cleanup, { name: "My Recipe" });

      expect((await getDoc(boxRef)).exists()).toBe(true);
    });

    it("should handle life tracker user accessing recipes (no boxes field)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // User created via life tracker - has lifeLogId but no boxes
      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });

      const userRef = doc(ctx.db, "users", user.localId);
      cleanup.track(userRef);
      await setDoc(userRef, {
        lifeLogId: logRef.id,
        createdAt: Timestamp.now(),
      });

      // Verify user doc structure
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toBeUndefined();
      expect(userSnap.data()?.lifeLogId).toBe(logRef.id);

      // User should be able to use recipes
      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      expect((await getDoc(boxRef)).exists()).toBe(true);
    });

    it("should handle recipes user accessing groceries (no slugs field)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // User created via recipes - has boxes but no slugs
      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      await createTestRecipesUser(ctx, cleanup, [boxRef.id]);

      // Verify user doc structure
      const userRef = doc(ctx.db, "users", user.localId);
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.slugs).toBeUndefined();
      expect(userSnap.data()?.boxes).toHaveLength(1);

      // User should be able to use groceries
      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });
      await createTestItem(ctx, listRef.id, cleanup, { name: "Milk" });

      expect((await getDoc(listRef)).exists()).toBe(true);
    });

    it("should handle recipes user accessing upkeep (no householdSlugs field)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // User created via recipes
      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      await createTestRecipesUser(ctx, cleanup, [boxRef.id]);

      // User should be able to use upkeep
      const taskListRef = await createTestTaskList(ctx, cleanup, { owners: [user.localId] });
      await createTestTask(ctx, taskListRef.id, cleanup, { name: "Clean kitchen" });

      expect((await getDoc(taskListRef)).exists()).toBe(true);
    });

    it("should handle recipes user accessing life tracker (no lifeLogId field)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // User created via recipes
      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      await createTestRecipesUser(ctx, cleanup, [boxRef.id]);

      // User should be able to use life tracker
      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });
      await createTestEntry(ctx, logRef.id, cleanup, { type: "sleep" });

      expect((await getDoc(logRef)).exists()).toBe(true);
    });
  });

  describe("User Document Field Merging", () => {
    it("should allow adding recipes boxes to groceries user", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // Create groceries user
      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });
      const userRef = doc(ctx.db, "users", user.localId);
      cleanup.track(userRef);
      await setDoc(userRef, {
        slugs: { groceries: listRef.id },
        createdAt: Timestamp.now(),
      });

      // Add recipes box and update user doc
      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      await setDoc(userRef, {
        boxes: [doc(ctx.db, "boxes", boxRef.id)],
        visibility: "private",
        name: user.email,
        lastSeen: Timestamp.now(),
        newSeen: Timestamp.now(),
      }, { merge: true });

      // Verify both fields coexist
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.slugs?.groceries).toBe(listRef.id);
      expect(userSnap.data()?.boxes).toHaveLength(1);
    });

    it("should allow adding life log to recipes user", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // Create recipes user
      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      await createTestRecipesUser(ctx, cleanup, [boxRef.id]);

      // Add life log
      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });
      const userRef = doc(ctx.db, "users", user.localId);
      await setDoc(userRef, { lifeLogId: logRef.id }, { merge: true });

      // Verify both fields coexist
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toHaveLength(1);
      expect(userSnap.data()?.lifeLogId).toBe(logRef.id);
    });

    it("should handle user with all app fields", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // Create data for all apps
      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });
      const taskListRef = await createTestTaskList(ctx, cleanup, { owners: [user.localId] });
      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });
      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });

      // Create user doc with all fields
      const userRef = doc(ctx.db, "users", user.localId);
      cleanup.track(userRef);
      await setDoc(userRef, {
        // Groceries
        slugs: { groceries: listRef.id },
        // Upkeep
        householdSlugs: { home: taskListRef.id },
        // Life tracker
        lifeLogId: logRef.id,
        // Recipes
        boxes: [doc(ctx.db, "boxes", boxRef.id)],
        visibility: "private",
        name: user.email,
        lastSeen: Timestamp.now(),
        newSeen: Timestamp.now(),
        cookingModeSeen: false,
        lastSeenUpdateVersion: 0,
        createdAt: Timestamp.now(),
      });

      // Verify all fields
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.slugs?.groceries).toBe(listRef.id);
      expect(userSnap.data()?.householdSlugs?.home).toBe(taskListRef.id);
      expect(userSnap.data()?.lifeLogId).toBe(logRef.id);
      expect(userSnap.data()?.boxes).toHaveLength(1);
    });
  });

  describe("Empty/Missing Field Handling", () => {
    it("should handle completely empty user document", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // Create minimal user doc
      const userRef = doc(ctx.db, "users", user.localId);
      cleanup.track(userRef);
      await setDoc(userRef, {
        createdAt: Timestamp.now(),
      });

      // Verify all app-specific fields are undefined
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toBeUndefined();
      expect(userSnap.data()?.slugs).toBeUndefined();
      expect(userSnap.data()?.householdSlugs).toBeUndefined();
      expect(userSnap.data()?.lifeLogId).toBeUndefined();

      // User should still be able to use all apps
      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });
      const taskListRef = await createTestTaskList(ctx, cleanup, { owners: [user.localId] });
      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });

      expect((await getDoc(boxRef)).exists()).toBe(true);
      expect((await getDoc(listRef)).exists()).toBe(true);
      expect((await getDoc(taskListRef)).exists()).toBe(true);
      expect((await getDoc(logRef)).exists()).toBe(true);
    });

    it("should handle null values gracefully", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // Create user doc with null values
      const userRef = doc(ctx.db, "users", user.localId);
      cleanup.track(userRef);
      await setDoc(userRef, {
        boxes: null,
        slugs: null,
        householdSlugs: null,
        lifeLogId: null,
        createdAt: Timestamp.now(),
      });

      // Verify nulls are stored
      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.boxes).toBeNull();

      // User should still be able to create app data
      const boxRef = await createTestBox(ctx, cleanup, { owners: [user.localId] });
      expect((await getDoc(boxRef)).exists()).toBe(true);
    });
  });
});
