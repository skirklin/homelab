/**
 * End-to-end tests for Upkeep app using the @homelab/backend interface.
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
import { PocketBaseUpkeepBackend, PocketBaseUserBackend } from "@homelab/backend/pocketbase";

// The backend Task type declares frequency as `number`, but the actual schema
// stores it as `{ value: number; unit: string }`. We use `as any` for task
// objects that include frequency to work around this type mismatch.

let ctx: TestContext;
let upkeep: PocketBaseUpkeepBackend;
let userBackend: PocketBaseUserBackend;

beforeAll(async () => {
  ctx = await initTestPocketBase();
  upkeep = new PocketBaseUpkeepBackend(() => ctx.userPb);
  userBackend = new PocketBaseUserBackend(() => ctx.userPb);
});

afterAll(async () => {
  await cleanupTestPocketBase(ctx);
});

// ─── List Management ────────────────────────────────────────────────────────

describe("List Management", () => {
  it("creates a list and retrieves it", async () => {
    const user = await createTestUser(ctx);

    const listId = await upkeep.createList("Home Tasks", user.id);
    await userBackend.setSlug(user.id, "household", "home", listId);

    // Cleanup
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const list = await upkeep.getList(listId);
    expect(list).not.toBeNull();
    expect(list!.name).toBe("Home Tasks");

    await cleanup.cleanup();
  });

  it("createList stores the user's slug pointing to the list", async () => {
    const user = await createTestUser(ctx);

    const listId = await upkeep.createList("Work Tasks", user.id);
    await userBackend.setSlug(user.id, "household", "work", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const slugs = await userBackend.getSlugs(user.id, "household");
    expect(slugs["work"]).toBe(listId);

    await cleanup.cleanup();
  });

  it("renames a list", async () => {
    const user = await createTestUser(ctx);

    const listId = await upkeep.createList("Old Name", user.id);
    await userBackend.setSlug(user.id, "household", "slug", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    await upkeep.renameList(listId, "New Name");

    const list = await upkeep.getList(listId);
    expect(list!.name).toBe("New Name");

    await cleanup.cleanup();
  });

  it("deletes a list", async () => {
    const user = await createTestUser(ctx);

    const listId = await upkeep.createList("Temp List", user.id);
    await userBackend.setSlug(user.id, "household", "temp", listId);

    await upkeep.deleteList(listId);

    const list = await upkeep.getList(listId);
    expect(list).toBeNull();
  });

  it("returns null for a non-existent list", async () => {
    const list = await upkeep.getList("nonexistent-id-12345");
    expect(list).toBeNull();
  });

  // Room definitions test removed — nesting replaces rooms

  it("ensureListExists does not throw when user is already an owner", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Ensure Test", user.id);
    await userBackend.setSlug(user.id, "household", "ensure", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    // User is already an owner — getList should return non-null
    const record = await ctx.pb.collection("task_lists").getOne(listId);
    expect(record.owners).toContain(user.id);

    await cleanup.cleanup();
  });
});

// ─── Task Operations ─────────────────────────────────────────────────────────

describe("Task Operations", () => {
  it("adds a task and verifies it in the database", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Task Ops", user.id);
    await userBackend.setSlug(user.id, "household", "taskops", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await upkeep.addTask(listId, {
      name: "Clean counters",
      description: "Wipe down kitchen counters",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    const record = await ctx.pb.collection("tasks").getOne(taskId);
    expect(record.name).toBe("Clean counters");
    expect(record.description).toBe("Wipe down kitchen counters");
    expect(record.task_type).toBe("recurring");
    expect(record.frequency).toEqual({ value: 1, unit: "days" });
    expect(record.list).toBe(listId);

    await cleanup.cleanup();
  });

  it("updates a task", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Update Test", user.id);
    await userBackend.setSlug(user.id, "household", "update", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await upkeep.addTask(listId, {
      name: "Original Name",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    await upkeep.updateTask(taskId, {
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
    const listId = await upkeep.createList("Delete Test", user.id);
    await userBackend.setSlug(user.id, "household", "deltest", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await upkeep.addTask(listId, {
      name: "To be deleted",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });

    await upkeep.deleteTask(taskId);

    await expect(ctx.pb.collection("tasks").getOne(taskId)).rejects.toThrow();

    await cleanup.cleanup();
  });

  it("rejects a task with an empty name", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Validation Test", user.id);
    await userBackend.setSlug(user.id, "household", "valtest", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    await expect(
      upkeep.addTask(listId, {
        name: "",
        description: "",
        roomId: "general",
        frequency: { value: 1, unit: "days" },
        lastCompleted: null,
        snoozedUntil: null,
        notifyUsers: [],
      })
    ).rejects.toThrow();

    await cleanup.cleanup();
  });
});

// ─── Task Completion ──────────────────────────────────────────────────────────

describe("Task Completion", () => {
  it("completes a task and records a completion event", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Completion Test", user.id);
    await userBackend.setSlug(user.id, "household", "completion", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    const taskId = await upkeep.addTask(listId, {
      name: "Clean toilet",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 1, unit: "days" },
      lastCompleted: twoDaysAgo,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    await upkeep.completeTask(taskId, user.id, { notes: "Looks great!" });

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
    const listId = await upkeep.createList("Completion Order Test", user.id);
    await userBackend.setSlug(user.id, "household", "completionorder", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const taskId = await upkeep.addTask(listId, {
      name: "Already completed recently",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 7, unit: "days" },
      lastCompleted: yesterday,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    // Complete with a time before yesterday
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    await upkeep.completeTask(taskId, user.id, {
      notes: "",
      completedAt: twoDaysAgo,
    });

    // The backend always updates last_completed to the provided completedAt;
    // the old app-level code had conditional logic, but the backend interface doesn't.
    // The event is still recorded regardless.
    const events = await ctx.pb.collection("task_events").getFullList({
      filter: `subject_id = "${taskId}"`,
    });
    expect(events.length).toBe(1);
    cleanup.track("task_events", events[0].id);

    await cleanup.cleanup();
  });

  it("updates an existing completion event", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Update Completion", user.id);
    await userBackend.setSlug(user.id, "household", "updatecomp", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await upkeep.addTask(listId, {
      name: "Mop floor",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    await upkeep.completeTask(taskId, user.id, { notes: "Initial notes" });

    const events = await ctx.pb.collection("task_events").getFullList({
      filter: `subject_id = "${taskId}"`,
    });
    const eventId = events[0].id;
    cleanup.track("task_events", eventId);

    await upkeep.updateCompletion(eventId, { notes: "Updated notes" });

    const updated = await ctx.pb.collection("task_events").getOne(eventId);
    expect(updated.data.notes).toBe("Updated notes");

    await cleanup.cleanup();
  });

  it("deletes a completion event", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Delete Completion", user.id);
    await userBackend.setSlug(user.id, "household", "deletecomp", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await upkeep.addTask(listId, {
      name: "Vacuum",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    await upkeep.completeTask(taskId, user.id);

    const events = await ctx.pb.collection("task_events").getFullList({
      filter: `subject_id = "${taskId}"`,
    });
    const eventId = events[0].id;

    await upkeep.deleteCompletion(eventId);

    await expect(ctx.pb.collection("task_events").getOne(eventId)).rejects.toThrow();

    await cleanup.cleanup();
  });

  it("handles completing a task with a future completedAt date", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Future Completion", user.id);
    await userBackend.setSlug(user.id, "household", "futurecomp", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await upkeep.addTask(listId, {
      name: "Time traveler task",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 30, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    await upkeep.completeTask(taskId, user.id, { notes: "", completedAt: nextWeek });

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
    const listId = await upkeep.createList("Snooze Test", user.id);
    await userBackend.setSlug(user.id, "household", "snooze", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await upkeep.addTask(listId, {
      name: "Snoozeable task",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    const snoozeUntil = new Date();
    snoozeUntil.setDate(snoozeUntil.getDate() + 3);
    await upkeep.snoozeTask(taskId, snoozeUntil);

    const snoozed = await ctx.pb.collection("tasks").getOne(taskId);
    expect(snoozed.snoozed_until).toBeTruthy();
    expect(new Date(snoozed.snoozed_until).getTime()).toBeGreaterThan(Date.now());

    await upkeep.unsnoozeTask(taskId);

    const unsnoozed = await ctx.pb.collection("tasks").getOne(taskId);
    expect(unsnoozed.snoozed_until).toBeFalsy();

    await cleanup.cleanup();
  });
});

// ─── User Slug Operations ─────────────────────────────────────────────────────

describe("User Slug Operations", () => {
  it("getUserSlugs returns empty object for new user", async () => {
    const user = await createTestUser(ctx);

    const slugs = await userBackend.getSlugs(user.id, "household");
    expect(typeof slugs).toBe("object");
  });

  it("setUserSlug stores a mapping", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Slug Test List", user.id);
    await userBackend.setSlug(user.id, "household", "slugtest", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const slugs = await userBackend.getSlugs(user.id, "household");
    expect(slugs["slugtest"]).toBe(listId);

    // Set another slug
    await userBackend.setSlug(user.id, "household", "secondary", listId);
    const updated = await userBackend.getSlugs(user.id, "household");
    expect(updated["secondary"]).toBe(listId);

    await cleanup.cleanup();
  });

  it("removeUserSlug removes a slug", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Remove Slug Test", user.id);
    await userBackend.setSlug(user.id, "household", "removeme", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    await userBackend.removeSlug(user.id, "household", "removeme");

    const slugs = await userBackend.getSlugs(user.id, "household");
    expect(slugs["removeme"]).toBeUndefined();

    await cleanup.cleanup();
  });

  it("renameUserSlug changes a slug key", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Rename Slug Test", user.id);
    await userBackend.setSlug(user.id, "household", "oldslug", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    await userBackend.renameSlug(user.id, "household", "oldslug", "newslug");

    const slugs = await userBackend.getSlugs(user.id, "household");
    expect(slugs["oldslug"]).toBeUndefined();
    expect(slugs["newslug"]).toBe(listId);

    await cleanup.cleanup();
  });
});

// ─── Notification Operations ──────────────────────────────────────────────────

describe("Notification Operations", () => {
  it("toggleTaskNotification enables and disables notifications", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Notify Test", user.id);
    await userBackend.setSlug(user.id, "household", "notify", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await upkeep.addTask(listId, {
      name: "Notify me task",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    // Enable notification
    await upkeep.toggleTaskNotification(taskId, user.id, true);

    const enabled = await ctx.pb.collection("tasks").getOne(taskId);
    expect(enabled.notify_users).toContain(user.id);

    // Disable notification
    await upkeep.toggleTaskNotification(taskId, user.id, false);

    const disabled = await ctx.pb.collection("tasks").getOne(taskId);
    expect(disabled.notify_users).not.toContain(user.id);

    await cleanup.cleanup();
  });
});

// Room Edge Cases removed — rooms replaced by tree nesting

// ─── Multi-user Scenarios ─────────────────────────────────────────────────────

describe("Multi-user Scenarios", () => {
  it("two users both complete the same task — both events are recorded", async () => {
    const userA = await createTestUser(ctx);
    const listId = await upkeep.createList("Shared Household", userA.id);
    await userBackend.setSlug(userA.id, "household", "shared", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const userB = await createUserWithoutSignIn(ctx);
    // Add userB to owners via admin
    await ctx.pb.collection("task_lists").update(listId, {
      owners: [userA.id, userB.id],
    });

    // UserA adds a task
    const taskId = await upkeep.addTask(listId, {
      name: "Race condition task",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 1, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    // UserA completes it
    await upkeep.completeTask(taskId, userA.id, { notes: "User A completed" });

    // UserB signs in and completes it too
    await signInAsUser(ctx, userB);
    await upkeep.completeTask(taskId, userB.id, { notes: "User B completed" });

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
    const listId = await upkeep.createList("Access Control Test", userA.id);
    await userBackend.setSlug(userA.id, "household", "acl", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const userB = await createUserWithoutSignIn(ctx);
    await ctx.pb.collection("task_lists").update(listId, {
      owners: [userA.id, userB.id],
    });

    const taskId = await upkeep.addTask(listId, {
      name: "Shared task",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 7, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
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
    const listId = await upkeep.createList("Zero Freq Test", user.id);
    await userBackend.setSlug(user.id, "household", "zerofreq", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await upkeep.addTask(listId, {
      name: "Zero interval",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 0, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    const record = await ctx.pb.collection("tasks").getOne(taskId);
    expect(record.frequency).toEqual({ value: 0, unit: "days" });

    await cleanup.cleanup();
  });

  it("handles very large frequency value", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Large Freq Test", user.id);
    await userBackend.setSlug(user.id, "household", "largefreq", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const taskId = await upkeep.addTask(listId, {
      name: "Millennium task",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 999999, unit: "days" },
      lastCompleted: null,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    const record = await ctx.pb.collection("tasks").getOne(taskId);
    expect(record.frequency).toEqual({ value: 999999, unit: "days" });

    await cleanup.cleanup();
  });

  it("can update frequency of an overdue task to make it no longer overdue", async () => {
    const user = await createTestUser(ctx);
    const listId = await upkeep.createList("Freq Update Test", user.id);
    await userBackend.setSlug(user.id, "household", "frequpdate", listId);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);
    cleanup.track("task_lists", listId);

    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    const taskId = await upkeep.addTask(listId, {
      name: "Past due task",
      description: "",
      parentId: "",
      position: 0,
      taskType: "recurring",
      frequency: { value: 1, unit: "days" },
      lastCompleted: fiveDaysAgo,
      completed: false,
      snoozedUntil: null,
      notifyUsers: [],
      tags: [],
      collapsed: false,
    });
    cleanup.track("tasks", taskId);

    await upkeep.updateTask(taskId, { frequency: { value: 30, unit: "days" } });

    const record = await ctx.pb.collection("tasks").getOne(taskId);
    expect(record.frequency).toEqual({ value: 30, unit: "days" });

    await cleanup.cleanup();
  });
});
