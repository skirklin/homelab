/**
 * Edge case and corner case tests for Upkeep app
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  initTestFirebase,
  createUserWithoutSignIn,
  signInAsUser,
  cleanupTestFirebase,
  TestCleanup,
  createTestTaskList,
  createTestTask,
  type TestContext,
} from "@kirkl/shared";
import {
  collection,
  getDoc,
  getDocs,
  deleteDoc,
  updateDoc,
  addDoc,
  arrayRemove,
  Timestamp,
} from "firebase/firestore";

let ctx: TestContext;
let cleanup: TestCleanup;

describe("Upkeep Edge Cases", () => {
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

  describe("Room/Category Edge Cases", () => {
    it("should handle deleting a room that has tasks assigned to it", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestTaskList(ctx, cleanup, {
        owners: [user.localId],
        roomDefs: [
          { id: "kitchen", name: "Kitchen", color: "#ef4444" },
          { id: "bathroom", name: "Bathroom", color: "#3b82f6" },
        ],
      });

      // Add tasks to kitchen
      await createTestTask(ctx, listRef.id, cleanup, { name: "Clean counters", roomId: "kitchen" });
      await createTestTask(ctx, listRef.id, cleanup, { name: "Wash dishes", roomId: "kitchen" });

      // Delete the kitchen room
      await updateDoc(listRef, {
        roomDefs: [{ id: "bathroom", name: "Bathroom", color: "#3b82f6" }],
      });

      // Tasks still exist with orphaned roomId
      const tasks = await getDocs(collection(ctx.db, "taskLists", listRef.id, "tasks"));
      expect(tasks.size).toBe(2);
      expect(tasks.docs.every((d) => d.data().roomId === "kitchen")).toBe(true);
    });

    it("should handle task with invalid/non-existent room", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestTaskList(ctx, cleanup, {
        owners: [user.localId],
        roomDefs: [{ id: "kitchen", name: "Kitchen", color: "#ef4444" }],
      });

      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Ghost Room Task",
        roomId: "nonexistent-room",
      });

      const taskSnap = await getDoc(taskRef);
      expect(taskSnap.data()?.roomId).toBe("nonexistent-room");
    });
  });

  describe("Task Completion Edge Cases", () => {
    it("should handle completing a task that was just deleted", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestTaskList(ctx, cleanup, { owners: [user.localId] });
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Soon to be deleted",
      });
      const taskId = taskRef.id;

      // Delete the task
      await deleteDoc(taskRef);

      // Record completion for deleted task (orphaned reference)
      const completionRef = await addDoc(
        collection(ctx.db, "taskLists", listRef.id, "completions"),
        {
          taskId,
          completedBy: user.localId,
          completedAt: Timestamp.now(),
          notes: "Completed after deletion",
        }
      );
      cleanup.track(completionRef);

      const completionSnap = await getDoc(completionRef);
      expect(completionSnap.exists()).toBe(true);
      expect(completionSnap.data()?.taskId).toBe(taskId);

      // Task doesn't exist
      const taskSnap = await getDoc(taskRef);
      expect(taskSnap.exists()).toBe(false);
    });

    it("should handle setting lastCompleted to future date", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestTaskList(ctx, cleanup, { owners: [user.localId] });
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Time traveler task",
      });

      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      await updateDoc(taskRef, { lastCompleted: Timestamp.fromDate(nextWeek) });

      const taskSnap = await getDoc(taskRef);
      expect(taskSnap.data()?.lastCompleted.toDate().getTime()).toBeGreaterThan(Date.now());
    });

    it("should handle negative or zero frequency values", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestTaskList(ctx, cleanup, { owners: [user.localId] });

      const zeroTask = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Zero frequency",
        frequency: { value: 0, unit: "days" },
      });

      const negTask = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Negative frequency",
        frequency: { value: -5, unit: "days" },
      });

      expect((await getDoc(zeroTask)).data()?.frequency.value).toBe(0);
      expect((await getDoc(negTask)).data()?.frequency.value).toBe(-5);
    });

    it("should handle extremely large frequency values", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestTaskList(ctx, cleanup, { owners: [user.localId] });
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Millennium task",
        frequency: { value: 999999, unit: "days" },
      });

      expect((await getDoc(taskRef)).data()?.frequency.value).toBe(999999);
    });
  });

  describe("Multi-user Conflict Scenarios", () => {
    it("should handle User A removing User B while B is completing a task", async () => {
      const userA = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, userA);

      const listRef = await createTestTaskList(ctx, cleanup, { owners: [userA.localId] });

      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(listRef, { owners: [userA.localId, userB.localId] });

      // User B creates a task
      await signInAsUser(ctx, userB);
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, { name: "Shared task" });

      // User A removes User B
      await signInAsUser(ctx, userA);
      await updateDoc(listRef, { owners: arrayRemove(userB.localId) });

      // User B tries to complete (should fail)
      await signInAsUser(ctx, userB);
      await expect(
        updateDoc(taskRef, { lastCompleted: Timestamp.now() })
      ).rejects.toThrow();
    });

    it("should handle both users recording completions for the same task", async () => {
      const userA = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, userA);

      const listRef = await createTestTaskList(ctx, cleanup, { owners: [userA.localId] });

      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(listRef, { owners: [userA.localId, userB.localId] });

      const taskRef = await createTestTask(ctx, listRef.id, cleanup, { name: "Race condition task" });
      const completionsRef = collection(ctx.db, "taskLists", listRef.id, "completions");

      // User A completes
      const timeA = Timestamp.now();
      await updateDoc(taskRef, { lastCompleted: timeA, updatedAt: timeA });
      const compA = await addDoc(completionsRef, {
        taskId: taskRef.id,
        completedBy: userA.localId,
        completedAt: timeA,
        notes: "User A completed",
      });
      cleanup.track(compA);

      // User B also completes
      await signInAsUser(ctx, userB);
      const timeB = Timestamp.now();
      await updateDoc(taskRef, { lastCompleted: timeB, updatedAt: timeB });
      const compB = await addDoc(completionsRef, {
        taskId: taskRef.id,
        completedBy: userB.localId,
        completedAt: timeB,
        notes: "User B completed",
      });
      cleanup.track(compB);

      // Both completions exist
      const completions = await getDocs(completionsRef);
      expect(completions.size).toBe(2);

      // Last write wins
      expect((await getDoc(taskRef)).data()?.lastCompleted.toMillis()).toBe(timeB.toMillis());
    });
  });

  describe("Task State Edge Cases", () => {
    it("should handle task with null lastCompleted (never done)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestTaskList(ctx, cleanup, { owners: [user.localId] });
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Never completed",
        lastCompleted: null,
      });

      expect((await getDoc(taskRef)).data()?.lastCompleted).toBeNull();
    });

    it("should handle task with empty name", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestTaskList(ctx, cleanup, { owners: [user.localId] });
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, { name: "" });

      expect((await getDoc(taskRef)).data()?.name).toBe("");
    });

    it("should handle changing frequency of past due task", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestTaskList(ctx, cleanup, { owners: [user.localId] });

      const fiveDaysAgo = new Date();
      fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Past due task",
        frequency: { value: 1, unit: "days" },
        lastCompleted: Timestamp.fromDate(fiveDaysAgo),
      });

      // Change to monthly (no longer past due)
      await updateDoc(taskRef, { frequency: { value: 1, unit: "months" } });

      expect((await getDoc(taskRef)).data()?.frequency.unit).toBe("months");
    });
  });

  describe("List State Edge Cases", () => {
    it("should handle list with no tasks", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestTaskList(ctx, cleanup, {
        owners: [user.localId],
        roomDefs: [{ id: "kitchen", name: "Kitchen", color: "#ef4444" }],
      });

      const tasks = await getDocs(collection(ctx.db, "taskLists", listRef.id, "tasks"));
      expect(tasks.empty).toBe(true);
    });

    it("should handle list with no room definitions", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const listRef = await createTestTaskList(ctx, cleanup, {
        owners: [user.localId],
        roomDefs: [],
      });

      // Can still add tasks with arbitrary roomId
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Homeless task",
        roomId: "undefined-room",
      });

      expect((await getDoc(taskRef)).exists()).toBe(true);
    });
  });
});
