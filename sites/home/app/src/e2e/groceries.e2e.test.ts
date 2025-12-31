/**
 * E2E tests for Groceries module within the Home app
 *
 * Tests the groceries functionality when embedded in the combined home app.
 * Verifies that groceries operations work correctly in the integrated context.
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
  deleteDoc,
  arrayUnion,
  collection,
  Timestamp,
} from "firebase/firestore";

let ctx: TestContext;
let cleanup: TestCleanup;

describe("Groceries Module in Home App", () => {
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

  describe("List CRUD Operations", () => {
    it("should create a grocery list", async () => {
      const listRef = await createTestList(ctx, cleanup, {
        name: "Home App Groceries",
      });

      const listSnap = await getDoc(listRef);
      expect(listSnap.exists()).toBe(true);
      expect(listSnap.data()?.name).toBe("Home App Groceries");
      expect(listSnap.data()?.owners).toContain(ctx.testUser!.uid);
    });

    it("should add items to a list", async () => {
      const listRef = await createTestList(ctx, cleanup);

      const item1 = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Milk",
        categoryId: "dairy",
      });
      const item2 = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Bread",
        categoryId: "bakery",
      });
      const item3 = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Eggs",
        categoryId: "dairy",
      });

      const itemsRef = collection(ctx.db, "lists", listRef.id, "items");
      const items = await getDocs(itemsRef);
      expect(items.size).toBe(3);
    });

    it("should check and uncheck items", async () => {
      const listRef = await createTestList(ctx, cleanup);
      const itemRef = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Apples",
      });

      // Check item
      await updateDoc(itemRef, {
        checked: true,
        checkedBy: ctx.testUser!.uid,
        checkedAt: Timestamp.now(),
      });

      let itemSnap = await getDoc(itemRef);
      expect(itemSnap.data()?.checked).toBe(true);

      // Uncheck item
      await updateDoc(itemRef, {
        checked: false,
        checkedBy: null,
        checkedAt: null,
      });

      itemSnap = await getDoc(itemRef);
      expect(itemSnap.data()?.checked).toBe(false);
    });

    it("should delete items", async () => {
      const listRef = await createTestList(ctx, cleanup);
      const itemRef = await createTestItem(ctx, listRef.id, cleanup, {
        name: "To Delete",
      });

      await deleteDoc(itemRef);

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.exists()).toBe(false);
    });

    it("should delete a list", async () => {
      const listRef = await createTestList(ctx, cleanup);
      await createTestItem(ctx, listRef.id, cleanup, { name: "Item 1" });
      await createTestItem(ctx, listRef.id, cleanup, { name: "Item 2" });

      // Delete the list
      await deleteDoc(listRef);

      const listSnap = await getDoc(listRef);
      expect(listSnap.exists()).toBe(false);
    });
  });

  describe("User Slugs", () => {
    it("should create and update user slugs", async () => {
      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      cleanup.track(userRef);

      await setDoc(userRef, {
        slugs: { groceries: "list-abc" },
      });

      let userSnap = await getDoc(userRef);
      expect(userSnap.data()?.slugs?.groceries).toBe("list-abc");

      // Add another slug
      await updateDoc(userRef, {
        "slugs.weekly": "list-xyz",
      });

      userSnap = await getDoc(userRef);
      expect(userSnap.data()?.slugs?.groceries).toBe("list-abc");
      expect(userSnap.data()?.slugs?.weekly).toBe("list-xyz");
    });

    it("should remove a slug", async () => {
      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      cleanup.track(userRef);

      await setDoc(userRef, {
        slugs: { groceries: "list-1", weekly: "list-2" },
      });

      const { deleteField } = await import("firebase/firestore");
      await updateDoc(userRef, {
        "slugs.weekly": deleteField(),
      });

      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.slugs?.groceries).toBe("list-1");
      expect(userSnap.data()?.slugs?.weekly).toBeUndefined();
    });
  });

  describe("Multi-user List Sharing", () => {
    it("should share a list with another user", async () => {
      const listRef = await createTestList(ctx, cleanup, {
        name: "Shared List",
      });

      // Create second user
      const user2 = await createUserWithoutSignIn(ctx);

      // Add user2 to owners
      await updateDoc(listRef, {
        owners: arrayUnion(user2.localId),
      });

      const listSnap = await getDoc(listRef);
      expect(listSnap.data()?.owners).toContain(ctx.testUser!.uid);
      expect(listSnap.data()?.owners).toContain(user2.localId);
    });

    it("should allow shared user to add items", async () => {
      const user1 = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user1);

      const listRef = await createTestList(ctx, cleanup, {
        name: "Collaborative List",
        owners: [user1.localId],
      });

      // Add user2
      const user2 = await createUserWithoutSignIn(ctx);
      await updateDoc(listRef, { owners: arrayUnion(user2.localId) });

      // Sign in as user2 and add an item
      await signInAsUser(ctx, user2);
      const itemRef = await createTestItem(ctx, listRef.id, cleanup, {
        name: "User 2's Item",
        addedBy: user2.localId,
      });

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.data()?.addedBy).toBe(user2.localId);
    });

    it("should allow shared user to check items", async () => {
      const user1 = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user1);

      const listRef = await createTestList(ctx, cleanup, {
        owners: [user1.localId],
      });
      const itemRef = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Shared Item",
      });

      // Add user2 and have them check the item
      const user2 = await createUserWithoutSignIn(ctx);
      await updateDoc(listRef, { owners: arrayUnion(user2.localId) });

      await signInAsUser(ctx, user2);
      await updateDoc(itemRef, {
        checked: true,
        checkedBy: user2.localId,
        checkedAt: Timestamp.now(),
      });

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.data()?.checkedBy).toBe(user2.localId);
    });
  });

  describe("Shopping History", () => {
    it("should record a shopping trip", async () => {
      const listRef = await createTestList(ctx, cleanup);

      // Add and check items
      await createTestItem(ctx, listRef.id, cleanup, {
        name: "Bananas",
        checked: true,
      });
      await createTestItem(ctx, listRef.id, cleanup, {
        name: "Oranges",
        checked: true,
      });

      // Record trip
      const tripRef = doc(collection(ctx.db, "lists", listRef.id, "trips"));
      cleanup.track(tripRef);
      await setDoc(tripRef, {
        completedAt: Timestamp.now(),
        items: [
          { name: "Bananas", categoryId: "produce" },
          { name: "Oranges", categoryId: "produce" },
        ],
        completedBy: ctx.testUser!.uid,
      });

      const tripSnap = await getDoc(tripRef);
      expect(tripSnap.exists()).toBe(true);
      expect(tripSnap.data()?.items).toHaveLength(2);
    });

    it("should retrieve shopping history", async () => {
      const listRef = await createTestList(ctx, cleanup);

      // Create multiple trips
      for (let i = 0; i < 3; i++) {
        const tripRef = doc(collection(ctx.db, "lists", listRef.id, "trips"));
        cleanup.track(tripRef);
        await setDoc(tripRef, {
          completedAt: Timestamp.now(),
          items: [{ name: `Trip ${i} Item` }],
        });
      }

      const tripsRef = collection(ctx.db, "lists", listRef.id, "trips");
      const trips = await getDocs(tripsRef);
      expect(trips.size).toBe(3);
    });
  });

  describe("Item Categories", () => {
    it("should organize items by category", async () => {
      const listRef = await createTestList(ctx, cleanup);

      await createTestItem(ctx, listRef.id, cleanup, {
        name: "Milk",
        categoryId: "dairy",
      });
      await createTestItem(ctx, listRef.id, cleanup, {
        name: "Cheese",
        categoryId: "dairy",
      });
      await createTestItem(ctx, listRef.id, cleanup, {
        name: "Bread",
        categoryId: "bakery",
      });
      await createTestItem(ctx, listRef.id, cleanup, {
        name: "Apples",
        categoryId: "produce",
      });

      const itemsRef = collection(ctx.db, "lists", listRef.id, "items");
      const items = await getDocs(itemsRef);

      const categories = new Set(items.docs.map(d => d.data().categoryId));
      expect(categories.size).toBe(3);
      expect(categories.has("dairy")).toBe(true);
      expect(categories.has("bakery")).toBe(true);
      expect(categories.has("produce")).toBe(true);
    });
  });
});
