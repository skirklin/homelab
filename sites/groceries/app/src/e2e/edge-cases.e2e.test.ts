/**
 * Edge case and corner case tests for Groceries app
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
  testId,
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

describe("Groceries Edge Cases", () => {
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

  describe("Category Edge Cases", () => {
    it("should handle deleting a category that has items assigned to it", async () => {
      const listRef = await createTestList(ctx, cleanup, {
        name: "Category Test",
        categoryDefs: [
          { id: "produce", name: "Produce", color: "#22c55e" },
          { id: "dairy", name: "Dairy", color: "#3b82f6" },
        ],
      });

      // Add items to "produce" category
      await createTestItem(ctx, listRef.id, cleanup, { name: "Apples", categoryId: "produce" });
      await createTestItem(ctx, listRef.id, cleanup, { name: "Bananas", categoryId: "produce" });

      // Delete the "produce" category
      await updateDoc(listRef, {
        categoryDefs: [{ id: "dairy", name: "Dairy", color: "#3b82f6" }],
      });

      // Items still exist with orphaned category reference
      const items = await getDocs(collection(ctx.db, "lists", listRef.id, "items"));
      expect(items.size).toBe(2);
      expect(items.docs.every((d) => d.data().categoryId === "produce")).toBe(true);

      // List no longer has produce category
      const listSnap = await getDoc(listRef);
      expect(listSnap.data()?.categoryDefs.find((c: any) => c.id === "produce")).toBeUndefined();
    });

    it("should handle items with invalid/missing category", async () => {
      const listRef = await createTestList(ctx, cleanup, {
        categoryDefs: [{ id: "dairy", name: "Dairy", color: "#3b82f6" }],
      });

      const itemRef = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Mystery Item",
        categoryId: "nonexistent-category",
      });

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.exists()).toBe(true);
      expect(itemSnap.data()?.categoryId).toBe("nonexistent-category");
    });
  });

  describe("Multi-user Conflict Scenarios", () => {
    it("should handle User A deleting a list while User B has items in it", async () => {
      const listRef = await createTestList(ctx, cleanup, { name: "Shared List to Delete" });

      // Add User B
      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(listRef, { owners: [ctx.testUser!.uid, userB.localId] });

      // User B adds items
      await signInAsUser(ctx, userB);
      await createTestItem(ctx, listRef.id, cleanup, { name: "User B's item" });

      // User B deletes the list
      await deleteDoc(listRef);

      const listSnap = await getDoc(listRef);
      expect(listSnap.exists()).toBe(false);
    });

    it("should handle User A removing User B from owners while B is using the list", async () => {
      const userA = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, userA);

      const listRef = await createTestList(ctx, cleanup, {
        name: "Remove Owner Test",
        owners: [userA.localId],
      });

      // Add User B
      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(listRef, { owners: [userA.localId, userB.localId] });

      // User B adds an item while still an owner
      await signInAsUser(ctx, userB);
      await createTestItem(ctx, listRef.id, cleanup, { name: "User B's item" });

      // User A removes User B
      await signInAsUser(ctx, userA);
      await updateDoc(listRef, { owners: arrayRemove(userB.localId) });

      // Verify User B is removed
      const listSnap = await getDoc(listRef);
      expect(listSnap.data()?.owners).not.toContain(userB.localId);

      // User B can no longer add items
      await signInAsUser(ctx, userB);
      const itemsRef = collection(ctx.db, "lists", listRef.id, "items");
      await expect(
        setDoc(doc(itemsRef), {
          name: "Unauthorized",
          categoryId: "misc",
          checked: false,
          addedBy: userB.localId,
          addedAt: Timestamp.now(),
        })
      ).rejects.toThrow();
    });

    it("should handle multiple items added by different users", async () => {
      const userA = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, userA);

      const listRef = await createTestList(ctx, cleanup, { owners: [userA.localId] });

      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(listRef, { owners: [userA.localId, userB.localId] });

      // User A adds item
      await createTestItem(ctx, listRef.id, cleanup, { name: "User A's milk" });

      // User B adds item
      await signInAsUser(ctx, userB);
      await createTestItem(ctx, listRef.id, cleanup, { name: "User B's bread" });

      const items = await getDocs(collection(ctx.db, "lists", listRef.id, "items"));
      expect(items.size).toBe(2);
      expect(items.docs.map((d) => d.data().name)).toContain("User A's milk");
      expect(items.docs.map((d) => d.data().name)).toContain("User B's bread");
    });
  });

  describe("Item State Edge Cases", () => {
    it("should handle checking an already checked item", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });
      const itemRef = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Milk",
        checked: true,
      });

      // Check again
      const newTime = Timestamp.now();
      await updateDoc(itemRef, { checked: true, checkedAt: newTime });

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.data()?.checked).toBe(true);
    });

    it("should handle unchecking a checked item", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });
      const itemRef = await createTestItem(ctx, listRef.id, cleanup, {
        name: "Eggs",
        checked: true,
      });

      await updateDoc(itemRef, { checked: false, checkedBy: null, checkedAt: null });

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.data()?.checked).toBe(false);
      expect(itemSnap.data()?.checkedBy).toBeNull();
    });

    it("should handle adding duplicate item names", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });

      await createTestItem(ctx, listRef.id, cleanup, { name: "Milk" });
      await createTestItem(ctx, listRef.id, cleanup, { name: "Milk" });

      const items = await getDocs(collection(ctx.db, "lists", listRef.id, "items"));
      expect(items.size).toBe(2);
      expect(items.docs.filter((d) => d.data().name === "Milk").length).toBe(2);
    });

    it("should handle empty item name", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });
      const itemRef = await createTestItem(ctx, listRef.id, cleanup, { name: "" });

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.data()?.name).toBe("");
    });

    it("should handle very long item names", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });
      const longName = "A".repeat(10000);
      const itemRef = await createTestItem(ctx, listRef.id, cleanup, { name: longName });

      const itemSnap = await getDoc(itemRef);
      expect(itemSnap.data()?.name.length).toBe(10000);
    });
  });

  describe("List State Edge Cases", () => {
    it("should handle empty list (no items)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });

      const items = await getDocs(collection(ctx.db, "lists", listRef.id, "items"));
      expect(items.empty).toBe(true);
    });

    it("should handle list with no owners (orphaned list)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });

      // Remove all owners
      await updateDoc(listRef, { owners: [] });

      let listSnap = await getDoc(listRef);
      expect(listSnap.data()?.owners).toEqual([]);

      // Can still read
      expect(listSnap.exists()).toBe(true);

      // Cannot delete
      await expect(deleteDoc(listRef)).rejects.toThrow();

      // Re-add self to clean up (join rule allows this)
      await updateDoc(listRef, { owners: [user.localId] });
    });

    it("should handle shopping trip with no items", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestList(ctx, cleanup, { owners: [user.localId] });

      const tripRef = doc(collection(ctx.db, "lists", listRef.id, "trips"));
      cleanup.track(tripRef);
      await setDoc(tripRef, { completedAt: Timestamp.now(), items: [] });

      const tripSnap = await getDoc(tripRef);
      expect(tripSnap.data()?.items).toEqual([]);
    });
  });

  describe("User Slug Edge Cases", () => {
    it("should handle user with no slugs", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const userRef = doc(ctx.db, "users", user.localId);
      cleanup.track(userRef);
      await setDoc(userRef, { createdAt: Timestamp.now() });

      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.slugs).toBeUndefined();
    });

    it("should handle slug pointing to non-existent list", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const userRef = doc(ctx.db, "users", user.localId);
      cleanup.track(userRef);
      await setDoc(userRef, { slugs: { groceries: "nonexistent-list-id" } });

      const userSnap = await getDoc(userRef);
      const slugListId = userSnap.data()?.slugs?.groceries;

      const listSnap = await getDoc(doc(ctx.db, "lists", slugListId));
      expect(listSnap.exists()).toBe(false);
    });
  });
});
