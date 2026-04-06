/**
 * End-to-end tests for Groceries app using Firebase emulators
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
  createTestList,
  createTestItem,
  type TestContext,
} from "@kirkl/shared";
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  arrayUnion,
  collection,
  Timestamp,
} from "firebase/firestore";

let ctx: TestContext;
let cleanup: TestCleanup;

describe("Groceries E2E Tests", () => {
  beforeAll(async () => {
    ctx = await initTestFirebase();
    await createTestUser(ctx);
  });

  afterAll(async () => {
    await cleanupTestFirebase(ctx);
  });

  afterEach(async () => {
    await cleanup.cleanup();
  });

  describe("List Management", () => {
    beforeAll(() => {
      cleanup = new TestCleanup();
    });

    it("should create a new grocery list", async () => {
      const listRef = await createTestList(ctx, cleanup, {
        name: "Weekly Groceries",
      });

      const listSnap = await getDoc(listRef);
      expect(listSnap.exists()).toBe(true);
      expect(listSnap.data()?.name).toBe("Weekly Groceries");
      expect(listSnap.data()?.owners).toContain(ctx.testUser!.uid);
    });

    it("should add an item to the list", async () => {
      const listRef = await createTestList(ctx, cleanup);
      const itemRef = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Milk",
        categoryId: "dairy",
      });

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.exists()).toBe(true);
      expect(itemSnap.data()?.name).toBe("Milk");
      expect(itemSnap.data()?.checked).toBe(false);
    });

    it("should check off an item", async () => {
      const listRef = await createTestList(ctx, cleanup);
      const itemRef = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Bread",
      });

      await updateDoc(itemRef, {
        checked: true,
        checkedBy: ctx.testUser!.uid,
        checkedAt: Timestamp.now(),
      });

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.data()?.checked).toBe(true);
      expect(itemSnap.data()?.checkedBy).toBe(ctx.testUser!.uid);
    });

    it("should delete an item", async () => {
      const listRef = await createTestList(ctx, cleanup);
      const itemRef = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Eggs",
      });

      // Manual delete (not through cleanup) to test deletion
      const { deleteDoc } = await import("firebase/firestore");
      await deleteDoc(itemRef);

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.exists()).toBe(false);
    });
  });

  describe("User Slugs", () => {
    beforeAll(() => {
      cleanup = new TestCleanup();
    });

    it("should save and retrieve user slugs", async () => {
      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      cleanup.track(userRef);

      await setDoc(userRef, {
        slugs: {
          groceries: "list-123",
          home: "list-456",
        },
      });

      const userSnap = await getDoc(userRef);
      expect(userSnap.exists()).toBe(true);
      expect(userSnap.data()?.slugs?.groceries).toBe("list-123");
      expect(userSnap.data()?.slugs?.home).toBe("list-456");
    });
  });

  describe("Multi-user Workflow", () => {
    beforeAll(() => {
      cleanup = new TestCleanup();
    });

    it("should allow sharing a list between users", async () => {
      // User 1 creates a list
      const listRef = await createTestList(ctx, cleanup, {
        name: "Shared Shopping",
      });

      // Create second user WITHOUT signing in
      const user2 = await createUserWithoutSignIn(ctx);

      // User 1 adds user 2 to the list owners
      await updateDoc(listRef, {
        owners: arrayUnion(user2.localId),
      });

      // Verify both users are owners
      const listSnap = await getDoc(listRef);
      expect(listSnap.data()?.owners).toContain(ctx.testUser!.uid);
      expect(listSnap.data()?.owners).toContain(user2.localId);

      // Sign in as user 2 to add an item
      await signInAsUser(ctx, user2);

      const itemRef = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Cheese",
        categoryId: "dairy",
      });

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.data()?.addedBy).toBe(user2.localId);
    });
  });

  describe("Shopping Trip Workflow", () => {
    beforeAll(() => {
      cleanup = new TestCleanup();
    });

    it("should record a shopping trip when clearing checked items", async () => {
      const currentUser = ctx.auth.currentUser!;

      const listRef = await createTestList(ctx, cleanup, {
        name: "Shopping Trip Test",
        owners: [currentUser.uid],
      });

      // Add checked items
      const item1Ref = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Apples",
        categoryId: "produce",
        checked: true,
      });
      const item2Ref = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Bananas",
        categoryId: "produce",
        checked: true,
      });

      // Record shopping trip
      const tripRef = doc(collection(ctx.db, "lists", listRef.id, "trips"));
      cleanup.track(tripRef);
      await setDoc(tripRef, {
        completedAt: Timestamp.now(),
        items: [
          { name: "Apples", categoryId: "produce" },
          { name: "Bananas", categoryId: "produce" },
        ],
      });

      // Delete checked items (simulate clearing)
      const { deleteDoc } = await import("firebase/firestore");
      await deleteDoc(item1Ref);
      await deleteDoc(item2Ref);

      // Verify trip was recorded
      const tripSnap = await getDoc(tripRef);
      expect(tripSnap.exists()).toBe(true);
      expect(tripSnap.data()?.items).toHaveLength(2);

      // Verify items were deleted
      const itemsRef = collection(ctx.db, "lists", listRef.id, "items");
      const remainingItems = await getDocs(itemsRef);
      expect(remainingItems.empty).toBe(true);
    });
  });
});
