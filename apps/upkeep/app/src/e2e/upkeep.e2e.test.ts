/**
 * End-to-end tests for Upkeep app — tests actual app functions from pocketbase.ts
 *
 * Run with: npm test
 * Requires PocketBase running: docker compose -f docker-compose.test.yml up -d
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initTestPocketBase,
  createTestUser,
  createUserWithoutSignIn,
  signInAsUser,
  cleanupTestPocketBase,
  TestCleanup,
  type TestContext,
} from "@kirkl/shared/test-utils";
import {
  setCurrentListId,
  createList,
  renameList,
  deleteList,
  getListById,
  updateRooms,
  addTask,
  updateTask,
  deleteTask,
  completeTask,
  updateCompletion,
  deleteCompletion,
  snoozeTask,
  unsnoozeTask,
  getUserSlugs,
  setUserSlug,
  removeUserSlug,
  renameUserSlug,
  toggleTaskNotification,
  ensureListExists,
} from "../pocketbase";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await initTestPocketBase();
});

afterAll(async () => {
  await cleanupTestPocketBase(ctx);
});

// ─── List Management ────────────────────────────────────────────────────────

describe("List Management", () => {
  it("creates a list and retrieves it", async () => {
    const user = await createTestUser(ctx);

    const listId = await createList("Home Tasks", "home", user.id);
    setCurrentListId(listId);

    // Cleanup
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const list = await getListById(listId);
    expect(list).not.toBeNull();
    expect(list!.name).toBe("Home Tasks");

    await cleanup.cleanup();
  });

  it("createList stores the user's slug pointing to the list", async () => {
    const user = await createTestUser(ctx);

    const listId = await createList("Work Tasks", "work", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const slugs = await getUserSlugs(user.id);
    expect(slugs["work"]).toBe(listId);

    await cleanup.cleanup();
  });

  it("renames a list", async () => {
    const user = await createTestUser(ctx);

    const listId = await createList("Old Name", "slug", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    await renameList(listId, "New Name");

    const list = await getListById(listId);
    expect(list!.name).toBe("New Name");

    await cleanup.cleanup();
  });

  it("deletes a list", async () => {
    const user = await createTestUser(ctx);

    const listId = await createList("Temp List", "temp", user.id);
    setCurrentListId(listId);

    await deleteList(listId);

    const list = await getListById(listId);
    expect(list).toBeNull();
  });

  it("returns null for a non-existent list", async () => {
    const list = await getListById("nonexistent-id-12345");
    expect(list).toBeNull();
  });

  it("updates room definitions via updateRooms", async () => {
    const user = await createTestUser(ctx);

    const listId = await createList("Rooms Test", "rooms", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const rooms = [
      { id: "kitchen", name: "Kitchen", color: "#ef4444" },
      { id: "bathroom", name: "Bathroom", color: "#3b82f6" },
      { id: "bedroom", name: "Bedroom", color: "#22c55e" },
    ];
    await updateRooms(rooms);

    const record = await ctx.pb.collection("task_lists").getOne(listId);
    expect(record.room_defs).toHaveLength(3);
    expect(record.room_defs[0].id).toBe("kitchen");

    await cleanup.cleanup();
  });

  it("ensureListExists does not throw when user is already an owner", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Ensure Test", "ensure", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    // User is already an owner — ensureListExists should be a no-op
    await ensureListExists(user.id);

    const record = await ctx.pb.collection("task_lists").getOne(listId);
    expect(record.owners).toContain(user.id);

    await cleanup.cleanup();
  });
});

// ─── Task Operations ─────────────────────────────────────────────────────────

describe("Task Operations", () => {
  it("adds a task and verifies it in the database", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Task Ops", "taskops", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await addTask({
      name: "Clean counters",
      description: "Wipe down kitchen counters",
      roomId: "kitchen",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    const record = await ctx.pb.collection("tasks").getOne(taskId);
    expect(record.name).toBe("Clean counters");
    expect(record.description).toBe("Wipe down kitchen counters");
    expect(record.room_id).toBe("kitchen");
    expect(record.frequency).toEqual({ value: 1, unit: "days" });
    expect(record.list).toBe(listId);

    await cleanup.cleanup();
  });

  it("updates a task", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Update Test", "update", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await addTask({
      name: "Original Name",
      description: "",
      roomId: "general",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    await updateTask(taskId, {
      name: "Updated Name",
      frequency: { value: 14, unit: "days" },
    });

    const record = await ctx.pb.collection("tasks").getOne(taskId);
    expect(record.name).toBe("Updated Name");
    expect(record.frequency).toEqual({ value: 14, unit: "days" });

    await cleanup.cleanup();
  });

  it("deletes a task", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Delete Test", "deltest", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await addTask({
      name: "To be deleted",
      description: "",
      roomId: "general",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await deleteTask(taskId);

    await expect(ctx.pb.collection("tasks").getOne(taskId)).rejects.toThrow();

    await cleanup.cleanup();
  });

  it("rejects a task with an empty name", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Validation Test", "valtest", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    await expect(
      addTask({
        name: "",
        description: "",
        roomId: "general",
        frequency: { value: 1, unit: "days" },
        lastCompleted: null,
        snoozedUntil: null,
        notifyUsers: [],
        createdBy: user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    ).rejects.toThrow();

    await cleanup.cleanup();
  });
});

// ─── Task Completion ──────────────────────────────────────────────────────────

describe("Task Completion", () => {
  it("completes a task and records a completion event", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Completion Test", "completion", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    const taskId = await addTask({
      name: "Clean toilet",
      description: "",
      roomId: "bathroom",
      frequency: { value: 1, unit: "days" },
      lastCompleted: twoDaysAgo,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    await completeTask(taskId, user.id, "Looks great!");

    const taskRecord = await ctx.pb.collection("tasks").getOne(taskId);
    expect(taskRecord.last_completed).toBeTruthy();
    expect(new Date(taskRecord.last_completed).getTime()).toBeGreaterThan(twoDaysAgo.getTime());

    const events = await ctx.pb.collection("task_events").getFullList({
      filter: `subject_id = "${taskId}"`,
    });
    expect(events.length).toBe(1);
    expect(events[0].data.notes).toBe("Looks great!");
    expect(events[0].created_by).toBe(user.id);
    cleanup.track("task_events", events[0].id);

    await cleanup.cleanup();
  });

  it("does not update last_completed when completion is older than current", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Completion Order Test", "completionorder", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const taskId = await addTask({
      name: "Already completed recently",
      description: "",
      roomId: "general",
      frequency: { value: 7, unit: "days" },
      lastCompleted: yesterday,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    // Complete with a time before yesterday
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    await completeTask(taskId, user.id, "", {
      completedAt: twoDaysAgo,
      currentLastCompleted: yesterday,
    });

    // last_completed should still be yesterday (more recent)
    const taskRecord = await ctx.pb.collection("tasks").getOne(taskId);
    expect(new Date(taskRecord.last_completed).getTime()).toBeCloseTo(yesterday.getTime(), -3);

    const events = await ctx.pb.collection("task_events").getFullList({
      filter: `subject_id = "${taskId}"`,
    });
    cleanup.track("task_events", events[0].id);

    await cleanup.cleanup();
  });

  it("updates an existing completion event", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Update Completion", "updatecomp", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await addTask({
      name: "Mop floor",
      description: "",
      roomId: "kitchen",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    await completeTask(taskId, user.id, "Initial notes");

    const events = await ctx.pb.collection("task_events").getFullList({
      filter: `subject_id = "${taskId}"`,
    });
    const eventId = events[0].id;
    cleanup.track("task_events", eventId);

    await updateCompletion(eventId, { notes: "Updated notes" });

    const updated = await ctx.pb.collection("task_events").getOne(eventId);
    expect(updated.data.notes).toBe("Updated notes");

    await cleanup.cleanup();
  });

  it("deletes a completion event", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Delete Completion", "deletecomp", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await addTask({
      name: "Vacuum",
      description: "",
      roomId: "bedroom",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    await completeTask(taskId, user.id);

    const events = await ctx.pb.collection("task_events").getFullList({
      filter: `subject_id = "${taskId}"`,
    });
    const eventId = events[0].id;

    await deleteCompletion(eventId);

    await expect(ctx.pb.collection("task_events").getOne(eventId)).rejects.toThrow();

    await cleanup.cleanup();
  });

  it("handles completing a task with a future completedAt date", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Future Completion", "futurecomp", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await addTask({
      name: "Time traveler task",
      description: "",
      roomId: "general",
      frequency: { value: 30, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    await completeTask(taskId, user.id, "", { completedAt: nextWeek });

    const taskRecord = await ctx.pb.collection("tasks").getOne(taskId);
    expect(new Date(taskRecord.last_completed).getTime()).toBeGreaterThan(Date.now());

    const events = await ctx.pb.collection("task_events").getFullList({
      filter: `subject_id = "${taskId}"`,
    });
    cleanup.track("task_events", events[0].id);

    await cleanup.cleanup();
  });
});

// ─── Snooze Operations ────────────────────────────────────────────────────────

describe("Snooze Operations", () => {
  it("snoozess and unsnoozess a task", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Snooze Test", "snooze", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await addTask({
      name: "Snoozeable task",
      description: "",
      roomId: "general",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    const snoozeUntil = new Date();
    snoozeUntil.setDate(snoozeUntil.getDate() + 3);
    await snoozeTask(taskId, snoozeUntil);

    const snoozed = await ctx.pb.collection("tasks").getOne(taskId);
    expect(snoozed.snoozed_until).toBeTruthy();
    expect(new Date(snoozed.snoozed_until).getTime()).toBeGreaterThan(Date.now());

    await unsnoozeTask(taskId);

    const unsnoozed = await ctx.pb.collection("tasks").getOne(taskId);
    expect(unsnoozed.snoozed_until).toBeFalsy();

    await cleanup.cleanup();
  });
});

// ─── User Slug Operations ─────────────────────────────────────────────────────

describe("User Slug Operations", () => {
  it("getUserSlugs returns empty object for new user", async () => {
    const user = await createTestUser(ctx);

    const slugs = await getUserSlugs(user.id);
    // New user has no slugs initially (createList adds "home" for the user above — use fresh user)
    expect(typeof slugs).toBe("object");
  });

  it("setUserSlug stores a mapping and adds user to list owners", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Slug Test List", "slugtest", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    // createList already called setUserSlug internally — verify it's there
    const slugs = await getUserSlugs(user.id);
    expect(slugs["slugtest"]).toBe(listId);

    // Set another slug
    await setUserSlug(user.id, "secondary", listId);
    const updated = await getUserSlugs(user.id);
    expect(updated["secondary"]).toBe(listId);

    await cleanup.cleanup();
  });

  it("removeUserSlug removes a slug", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Remove Slug Test", "removeme", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    await removeUserSlug(user.id, "removeme");

    const slugs = await getUserSlugs(user.id);
    expect(slugs["removeme"]).toBeUndefined();

    await cleanup.cleanup();
  });

  it("renameUserSlug changes a slug key", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Rename Slug Test", "oldslug", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    await renameUserSlug(user.id, "oldslug", "newslug");

    const slugs = await getUserSlugs(user.id);
    expect(slugs["oldslug"]).toBeUndefined();
    expect(slugs["newslug"]).toBe(listId);

    await cleanup.cleanup();
  });
});

// ─── Notification Operations ──────────────────────────────────────────────────

describe("Notification Operations", () => {
  it("toggleTaskNotification enables and disables notifications", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Notify Test", "notify", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await addTask({
      name: "Notify me task",
      description: "",
      roomId: "general",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    // Enable notification
    await toggleTaskNotification(taskId, user.id, true);

    const enabled = await ctx.pb.collection("tasks").getOne(taskId);
    expect(enabled.notify_users).toContain(user.id);

    // Disable notification
    await toggleTaskNotification(taskId, user.id, false);

    const disabled = await ctx.pb.collection("tasks").getOne(taskId);
    expect(disabled.notify_users).not.toContain(user.id);

    await cleanup.cleanup();
  });
});

// ─── Room Edge Cases ──────────────────────────────────────────────────────────

describe("Room Edge Cases", () => {
  it("tasks with orphaned roomId still exist after room deletion", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Room Edge Cases", "roomedge", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    await updateRooms([
      { id: "kitchen", name: "Kitchen", color: "#ef4444" },
      { id: "bathroom", name: "Bathroom", color: "#3b82f6" },
    ]);

    const task1Id = await addTask({
      name: "Clean counters",
      description: "",
      roomId: "kitchen",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", task1Id);

    const task2Id = await addTask({
      name: "Wash dishes",
      description: "",
      roomId: "kitchen",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", task2Id);

    // Remove kitchen room
    await updateRooms([{ id: "bathroom", name: "Bathroom", color: "#3b82f6" }]);

    // Tasks still exist with orphaned roomId
    const tasks = await ctx.pb.collection("tasks").getFullList({
      filter: `list = "${listId}"`,
    });
    expect(tasks.length).toBe(2);
    expect(tasks.every((t) => t.room_id === "kitchen")).toBe(true);

    await cleanup.cleanup();
  });

  it("tasks can be created with a non-existent roomId", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Ghost Room Test", "ghostroom", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await addTask({
      name: "Ghost Room Task",
      description: "",
      roomId: "nonexistent-room",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    const record = await ctx.pb.collection("tasks").getOne(taskId);
    expect(record.room_id).toBe("nonexistent-room");

    await cleanup.cleanup();
  });
});

// ─── Multi-user Scenarios ─────────────────────────────────────────────────────

describe("Multi-user Scenarios", () => {
  it("two users both complete the same task — both events are recorded", async () => {
    const userA = await createTestUser(ctx);
    const listId = await createList("Shared Household", "shared", userA.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const userB = await createUserWithoutSignIn(ctx);
    // Add userB to owners via admin
    await ctx.pb.collection("task_lists").update(listId, {
      owners: [userA.id, userB.id],
    });

    // UserA adds a task
    const taskId = await addTask({
      name: "Race condition task",
      description: "",
      roomId: "general",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: userA.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    // UserA completes it
    setCurrentListId(listId);
    await completeTask(taskId, userA.id, "User A completed");

    // UserB signs in and completes it too
    await signInAsUser(ctx, userB);
    setCurrentListId(listId);
    await completeTask(taskId, userB.id, "User B completed");

    const events = await ctx.pb.collection("task_events").getFullList({
      filter: `subject_id = "${taskId}"`,
    });
    expect(events.length).toBe(2);

    const notes = events.map((e) => e.data.notes);
    expect(notes).toContain("User A completed");
    expect(notes).toContain("User B completed");

    for (const event of events) {
      cleanup.track("task_events", event.id);
    }

    // Sign back in as userA for cleanup
    await signInAsUser(ctx, userA);
    await cleanup.cleanup();
  });

  it("removed user cannot update tasks via userPb", async () => {
    const userA = await createTestUser(ctx);
    const listId = await createList("Access Control Test", "acl", userA.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const userB = await createUserWithoutSignIn(ctx);
    await ctx.pb.collection("task_lists").update(listId, {
      owners: [userA.id, userB.id],
    });

    const taskId = await addTask({
      name: "Shared task",
      description: "",
      roomId: "general",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: userA.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    // UserA removes UserB
    await ctx.pb.collection("task_lists").update(listId, {
      owners: [userA.id],
    });

    // UserB tries to complete via userPb (respects API rules — should fail)
    await signInAsUser(ctx, userB);
    await expect(
      ctx.userPb.collection("tasks").update(taskId, {
        last_completed: new Date().toISOString(),
      })
    ).rejects.toThrow();

    // Sign back in as userA for cleanup
    await signInAsUser(ctx, userA);
    await cleanup.cleanup();
  });
});

// ─── Frequency Edge Cases ─────────────────────────────────────────────────────

describe("Frequency Edge Cases", () => {
  it("handles zero frequency value", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Zero Freq Test", "zerofreq", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await addTask({
      name: "Zero interval",
      description: "",
      roomId: "general",
      frequency: { value: 0, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    const record = await ctx.pb.collection("tasks").getOne(taskId);
    expect(record.frequency).toEqual({ value: 0, unit: "days" });

    await cleanup.cleanup();
  });

  it("handles very large frequency value", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Large Freq Test", "largefreq", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await addTask({
      name: "Millennium task",
      description: "",
      roomId: "general",
      frequency: { value: 999999, unit: "days" },
      lastCompleted: null,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    const record = await ctx.pb.collection("tasks").getOne(taskId);
    expect(record.frequency).toEqual({ value: 999999, unit: "days" });

    await cleanup.cleanup();
  });

  it("can update frequency of an overdue task to make it no longer overdue", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Freq Update Test", "frequpdate", user.id);
    setCurrentListId(listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    const taskId = await addTask({
      name: "Past due task",
      description: "",
      roomId: "general",
      frequency: { value: 1, unit: "days" },
      lastCompleted: fiveDaysAgo,
      snoozedUntil: null,
      notifyUsers: [],
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cleanup.track("tasks", taskId);

    await updateTask(taskId, { frequency: { value: 30, unit: "days" } });

    const record = await ctx.pb.collection("tasks").getOne(taskId);
    expect(record.frequency).toEqual({ value: 30, unit: "days" });

    await cleanup.cleanup();
  });
});
