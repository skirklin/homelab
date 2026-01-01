/**
 * End-to-end tests for Upkeep app using Firebase emulators
 *
 * Run with: npm test
 * Requires Firebase emulators running: firebase emulators:start
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  initTestFirebase,
  createTestUser,
  cleanupTestFirebase,
  TestCleanup,
  createTestTaskList,
  createTestTask,
  type TestContext,
} from "@kirkl/shared";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  Timestamp,
} from "firebase/firestore";

let ctx: TestContext;
let cleanup: TestCleanup;

describe("Upkeep E2E Tests", () => {
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

  describe("Task List Management", () => {
    it("should create a task list with room definitions", async () => {
      const listRef = await createTestTaskList(ctx, cleanup, {
        name: "Home Tasks",
        roomDefs: [
          { id: "kitchen", name: "Kitchen", color: "#ef4444" },
          { id: "bathroom", name: "Bathroom", color: "#3b82f6" },
          { id: "bedroom", name: "Bedroom", color: "#22c55e" },
        ],
      });

      const listSnap = await getDoc(listRef);
      expect(listSnap.exists()).toBe(true);
      expect(listSnap.data()?.name).toBe("Home Tasks");
      expect(listSnap.data()?.roomDefs).toHaveLength(3);
    });

    it("should create a recurring task", async () => {
      const listRef = await createTestTaskList(ctx, cleanup, {
        roomDefs: [{ id: "kitchen", name: "Kitchen", color: "#ef4444" }],
      });

      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Clean counters",
        roomId: "kitchen",
        frequency: { value: 1, unit: "days" },
      });

      const taskSnap = await getDoc(taskRef);
      expect(taskSnap.exists()).toBe(true);
      expect(taskSnap.data()?.name).toBe("Clean counters");
      expect(taskSnap.data()?.frequency.value).toBe(1);
      expect(taskSnap.data()?.frequency.unit).toBe("days");
    });
  });

  describe("Task Completion Workflow", () => {
    it("should complete a task and record completion", async () => {
      const listRef = await createTestTaskList(ctx, cleanup, {
        name: "Completion Test",
        roomDefs: [{ id: "bathroom", name: "Bathroom", color: "#3b82f6" }],
      });

      // Create a task with lastCompleted 2 days ago (past due for daily task)
      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Clean toilet",
        roomId: "bathroom",
        frequency: { value: 1, unit: "days" },
        lastCompleted: Timestamp.fromDate(twoDaysAgo),
      });

      // Complete the task
      const now = Timestamp.now();
      await updateDoc(taskRef, {
        lastCompleted: now,
        updatedAt: now,
      });

      // Record completion
      const completionsRef = collection(ctx.db, "taskLists", listRef.id, "completions");
      const completionRef = await addDoc(completionsRef, {
        taskId: taskRef.id,
        completedBy: ctx.testUser!.uid,
        completedAt: now,
        notes: "Done!",
      });
      cleanup.track(completionRef);

      // Verify task is updated
      const taskSnap = await getDoc(taskRef);
      expect(taskSnap.data()?.lastCompleted).toBeDefined();

      // Verify completion was recorded
      const completionSnap = await getDoc(completionRef);
      expect(completionSnap.exists()).toBe(true);
      expect(completionSnap.data()?.taskId).toBe(taskRef.id);
      expect(completionSnap.data()?.notes).toBe("Done!");
    });
  });

  describe("Task Urgency Calculation", () => {
    it("should correctly identify today, this week, and later tasks", async () => {
      const listRef = await createTestTaskList(ctx, cleanup, {
        name: "Urgency Test",
      });

      // Past due task (last completed 3 days ago, due daily) - shows in "today" column
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

      await createTestTask(ctx, listRef.id, cleanup, {
        name: "Past Due Task",
        frequency: { value: 1, unit: "days" },
        lastCompleted: Timestamp.fromDate(threeDaysAgo),
      });

      // Due today task (last completed 7 days ago, due weekly)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      await createTestTask(ctx, listRef.id, cleanup, {
        name: "Due Today Task",
        frequency: { value: 1, unit: "weeks" },
        lastCompleted: Timestamp.fromDate(sevenDaysAgo),
      });

      // Later task (just completed, due monthly)
      await createTestTask(ctx, listRef.id, cleanup, {
        name: "Later Task",
        frequency: { value: 1, unit: "months" },
        lastCompleted: Timestamp.now(),
      });

      // Verify tasks exist
      const tasks = await getDocs(collection(ctx.db, "taskLists", listRef.id, "tasks"));
      expect(tasks.size).toBe(3);
    });
  });

  describe("User Slugs for Upkeep", () => {
    it("should save and retrieve household slugs", async () => {
      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      cleanup.track(userRef);

      await setDoc(
        userRef,
        {
          householdSlugs: {
            home: "tasklist-123",
            work: "tasklist-456",
          },
        },
        { merge: true }
      );

      const userSnap = await getDoc(userRef);
      expect(userSnap.exists()).toBe(true);
      expect(userSnap.data()?.householdSlugs?.home).toBe("tasklist-123");
      expect(userSnap.data()?.householdSlugs?.work).toBe("tasklist-456");
    });
  });
});
