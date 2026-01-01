/**
 * E2E tests for Upkeep module within the Home app
 *
 * Tests the upkeep/household task functionality when embedded in the combined home app.
 * Verifies that task management operations work correctly in the integrated context.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  initTestFirebase,
  createTestUser,
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
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  arrayUnion,
  arrayRemove,
  Timestamp,
} from "firebase/firestore";

let ctx: TestContext;
let cleanup: TestCleanup;

describe("Upkeep Module in Home App", () => {
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

  describe("Task List CRUD Operations", () => {
    it("should create a task list with rooms", async () => {
      const listRef = await createTestTaskList(ctx, cleanup, {
        name: "Home App Tasks",
        roomDefs: [
          { id: "kitchen", name: "Kitchen", color: "#ef4444" },
          { id: "bathroom", name: "Bathroom", color: "#3b82f6" },
          { id: "living", name: "Living Room", color: "#22c55e" },
        ],
      });

      const listSnap = await getDoc(listRef);
      expect(listSnap.exists()).toBe(true);
      expect(listSnap.data()?.name).toBe("Home App Tasks");
      expect(listSnap.data()?.roomDefs).toHaveLength(3);
    });

    it("should update task list name", async () => {
      const listRef = await createTestTaskList(ctx, cleanup, {
        name: "Original Name",
      });

      await updateDoc(listRef, {
        name: "Updated Name",
        updatedAt: Timestamp.now(),
      });

      const listSnap = await getDoc(listRef);
      expect(listSnap.data()?.name).toBe("Updated Name");
    });

    it("should add a room to task list", async () => {
      const listRef = await createTestTaskList(ctx, cleanup, {
        roomDefs: [{ id: "kitchen", name: "Kitchen", color: "#ef4444" }],
      });

      await updateDoc(listRef, {
        roomDefs: arrayUnion({ id: "garage", name: "Garage", color: "#f59e0b" }),
      });

      const listSnap = await getDoc(listRef);
      expect(listSnap.data()?.roomDefs).toHaveLength(2);
    });

    it("should delete a task list", async () => {
      const listRef = await createTestTaskList(ctx, cleanup);

      await deleteDoc(listRef);

      const listSnap = await getDoc(listRef);
      expect(listSnap.exists()).toBe(false);
    });
  });

  describe("Task CRUD Operations", () => {
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

    it("should create tasks with different frequencies", async () => {
      const listRef = await createTestTaskList(ctx, cleanup);

      await createTestTask(ctx, listRef.id, cleanup, {
        name: "Daily task",
        frequency: { value: 1, unit: "days" },
      });
      await createTestTask(ctx, listRef.id, cleanup, {
        name: "Weekly task",
        frequency: { value: 1, unit: "weeks" },
      });
      await createTestTask(ctx, listRef.id, cleanup, {
        name: "Monthly task",
        frequency: { value: 1, unit: "months" },
      });
      await createTestTask(ctx, listRef.id, cleanup, {
        name: "Bi-weekly task",
        frequency: { value: 2, unit: "weeks" },
      });

      const tasksRef = collection(ctx.db, "taskLists", listRef.id, "tasks");
      const tasks = await getDocs(tasksRef);
      expect(tasks.size).toBe(4);
    });

    it("should update a task", async () => {
      const listRef = await createTestTaskList(ctx, cleanup);
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Original Task",
        frequency: { value: 1, unit: "days" },
      });

      await updateDoc(taskRef, {
        name: "Updated Task",
        frequency: { value: 2, unit: "weeks" },
        updatedAt: Timestamp.now(),
      });

      const taskSnap = await getDoc(taskRef);
      expect(taskSnap.data()?.name).toBe("Updated Task");
      expect(taskSnap.data()?.frequency.value).toBe(2);
      expect(taskSnap.data()?.frequency.unit).toBe("weeks");
    });

    it("should delete a task", async () => {
      const listRef = await createTestTaskList(ctx, cleanup);
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "To Delete",
      });

      await deleteDoc(taskRef);

      const taskSnap = await getDoc(taskRef);
      expect(taskSnap.exists()).toBe(false);
    });
  });

  describe("Task Completion Workflow", () => {
    it("should complete a task", async () => {
      const listRef = await createTestTaskList(ctx, cleanup);
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Complete Me",
        frequency: { value: 1, unit: "days" },
      });

      const now = Timestamp.now();
      await updateDoc(taskRef, {
        lastCompleted: now,
        updatedAt: now,
      });

      const taskSnap = await getDoc(taskRef);
      expect(taskSnap.data()?.lastCompleted).toBeDefined();
    });

    it("should record completion details", async () => {
      const listRef = await createTestTaskList(ctx, cleanup);
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Track Completion",
        frequency: { value: 1, unit: "weeks" },
      });

      // Record completion
      const completionsRef = collection(ctx.db, "taskLists", listRef.id, "completions");
      const completionRef = await addDoc(completionsRef, {
        taskId: taskRef.id,
        completedBy: ctx.testUser!.uid,
        completedAt: Timestamp.now(),
        notes: "Took longer than expected",
        duration: 30, // minutes
      });
      cleanup.track(completionRef);

      const completionSnap = await getDoc(completionRef);
      expect(completionSnap.exists()).toBe(true);
      expect(completionSnap.data()?.notes).toBe("Took longer than expected");
      expect(completionSnap.data()?.duration).toBe(30);
    });

    it("should track completion history", async () => {
      const listRef = await createTestTaskList(ctx, cleanup);
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Repeated Task",
        frequency: { value: 1, unit: "days" },
      });

      // Record multiple completions
      const completionsRef = collection(ctx.db, "taskLists", listRef.id, "completions");
      for (let i = 0; i < 5; i++) {
        const completionRef = await addDoc(completionsRef, {
          taskId: taskRef.id,
          completedBy: ctx.testUser!.uid,
          completedAt: Timestamp.now(),
        });
        cleanup.track(completionRef);
      }

      const completions = await getDocs(completionsRef);
      expect(completions.size).toBe(5);
    });
  });

  describe("Task Urgency and Scheduling", () => {
    it("should identify overdue tasks", async () => {
      const listRef = await createTestTaskList(ctx, cleanup);

      // Create overdue task (last completed 3 days ago, due daily)
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Overdue Task",
        frequency: { value: 1, unit: "days" },
        lastCompleted: Timestamp.fromDate(threeDaysAgo),
      });

      const taskSnap = await getDoc(taskRef);
      const lastCompleted = taskSnap.data()?.lastCompleted.toDate();
      const daysSince = Math.floor((Date.now() - lastCompleted.getTime()) / (1000 * 60 * 60 * 24));

      expect(daysSince).toBeGreaterThanOrEqual(2);
    });

    it("should identify tasks due today", async () => {
      const listRef = await createTestTaskList(ctx, cleanup);

      // Create task due today (last completed 7 days ago, due weekly)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Due Today",
        frequency: { value: 1, unit: "weeks" },
        lastCompleted: Timestamp.fromDate(sevenDaysAgo),
      });

      const taskSnap = await getDoc(taskRef);
      expect(taskSnap.exists()).toBe(true);
    });

    it("should identify tasks due later", async () => {
      const listRef = await createTestTaskList(ctx, cleanup);

      // Create task not due yet (just completed, due monthly)
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Due Later",
        frequency: { value: 1, unit: "months" },
        lastCompleted: Timestamp.now(),
      });

      const taskSnap = await getDoc(taskRef);
      expect(taskSnap.data()?.lastCompleted).toBeDefined();
    });
  });

  describe("User Slugs for Upkeep", () => {
    it("should save household slugs", async () => {
      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      cleanup.track(userRef);

      await setDoc(userRef, {
        householdSlugs: {
          home: "tasklist-123",
          cabin: "tasklist-456",
        },
      }, { merge: true });

      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.householdSlugs?.home).toBe("tasklist-123");
      expect(userSnap.data()?.householdSlugs?.cabin).toBe("tasklist-456");
    });

    it("should update household slugs", async () => {
      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      cleanup.track(userRef);

      await setDoc(userRef, {
        householdSlugs: { home: "list-1" },
      }, { merge: true });

      await updateDoc(userRef, {
        "householdSlugs.office": "list-2",
      });

      const userSnap = await getDoc(userRef);
      expect(userSnap.data()?.householdSlugs?.home).toBe("list-1");
      expect(userSnap.data()?.householdSlugs?.office).toBe("list-2");
    });
  });

  describe("Multi-user Task List Sharing", () => {
    it("should share a task list", async () => {
      const user1 = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user1);

      const listRef = await createTestTaskList(ctx, cleanup, {
        name: "Shared Chores",
        owners: [user1.localId],
      });

      // Add second user
      const user2 = await createUserWithoutSignIn(ctx);
      await updateDoc(listRef, { owners: arrayUnion(user2.localId) });

      const listSnap = await getDoc(listRef);
      expect(listSnap.data()?.owners).toContain(user1.localId);
      expect(listSnap.data()?.owners).toContain(user2.localId);
    });

    it("should allow shared user to complete tasks", async () => {
      const user1 = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user1);

      const listRef = await createTestTaskList(ctx, cleanup, {
        owners: [user1.localId],
      });
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "Shared Task",
        frequency: { value: 1, unit: "days" },
      });

      // Add user2 and have them complete the task
      const user2 = await createUserWithoutSignIn(ctx);
      await updateDoc(listRef, { owners: arrayUnion(user2.localId) });

      await signInAsUser(ctx, user2);

      const now = Timestamp.now();
      await updateDoc(taskRef, {
        lastCompleted: now,
        updatedAt: now,
      });

      // Record completion
      const completionsRef = collection(ctx.db, "taskLists", listRef.id, "completions");
      const completionRef = await addDoc(completionsRef, {
        taskId: taskRef.id,
        completedBy: user2.localId,
        completedAt: now,
      });
      cleanup.track(completionRef);

      const completionSnap = await getDoc(completionRef);
      expect(completionSnap.data()?.completedBy).toBe(user2.localId);
    });

    it("should allow shared user to add tasks", async () => {
      const user1 = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user1);

      const listRef = await createTestTaskList(ctx, cleanup, {
        owners: [user1.localId],
      });

      // Add user2
      const user2 = await createUserWithoutSignIn(ctx);
      await updateDoc(listRef, { owners: arrayUnion(user2.localId) });

      await signInAsUser(ctx, user2);
      const taskRef = await createTestTask(ctx, listRef.id, cleanup, {
        name: "User 2's Task",
        frequency: { value: 1, unit: "weeks" },
      });

      const taskSnap = await getDoc(taskRef);
      expect(taskSnap.data()?.name).toBe("User 2's Task");
    });

    it("should remove user from task list", async () => {
      const user1 = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user1);

      const listRef = await createTestTaskList(ctx, cleanup, {
        owners: [user1.localId],
      });

      const user2 = await createUserWithoutSignIn(ctx);
      await updateDoc(listRef, { owners: arrayUnion(user2.localId) });

      // Remove user2
      await updateDoc(listRef, { owners: arrayRemove(user2.localId) });

      const listSnap = await getDoc(listRef);
      expect(listSnap.data()?.owners).toContain(user1.localId);
      expect(listSnap.data()?.owners).not.toContain(user2.localId);
    });
  });

  describe("Room-based Task Organization", () => {
    it("should create tasks for different rooms", async () => {
      const listRef = await createTestTaskList(ctx, cleanup, {
        roomDefs: [
          { id: "kitchen", name: "Kitchen", color: "#ef4444" },
          { id: "bathroom", name: "Bathroom", color: "#3b82f6" },
        ],
      });

      await createTestTask(ctx, listRef.id, cleanup, {
        name: "Clean sink",
        roomId: "kitchen",
        frequency: { value: 1, unit: "days" },
      });
      await createTestTask(ctx, listRef.id, cleanup, {
        name: "Wipe counters",
        roomId: "kitchen",
        frequency: { value: 1, unit: "days" },
      });
      await createTestTask(ctx, listRef.id, cleanup, {
        name: "Clean toilet",
        roomId: "bathroom",
        frequency: { value: 1, unit: "weeks" },
      });

      const tasksRef = collection(ctx.db, "taskLists", listRef.id, "tasks");
      const tasks = await getDocs(tasksRef);

      const kitchenTasks = tasks.docs.filter(d => d.data().roomId === "kitchen");
      const bathroomTasks = tasks.docs.filter(d => d.data().roomId === "bathroom");

      expect(kitchenTasks).toHaveLength(2);
      expect(bathroomTasks).toHaveLength(1);
    });
  });
});
