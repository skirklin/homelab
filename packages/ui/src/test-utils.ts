/**
 * PocketBase test utilities for e2e tests.
 *
 * Usage:
 *   const ctx = await initTestPocketBase();
 *   const user = await createTestUser(ctx);
 *   // ... run tests using ctx.pb (admin-authed client) ...
 *   await cleanupTestPocketBase(ctx);
 *
 * Requires a PocketBase instance running at PB_TEST_URL (default: http://127.0.0.1:8091).
 * Start one with: docker compose -f docker-compose.test.yml up -d
 */

import PocketBase from "pocketbase";
import { initializeBackend } from "./backend";

const PB_TEST_URL = process.env.PB_TEST_URL || "http://127.0.0.1:8091";
const ADMIN_EMAIL = "test-admin@test.local";
const ADMIN_PASSWORD = "testpassword1234";

export interface TestContext {
  /** Admin-authenticated PocketBase client — bypasses API rules */
  pb: PocketBase;
  /** The currently "active" test user (set by createTestUser / signInAsUser) */
  testUser: TestUser | null;
  /** A second PB client authenticated as the test user (respects API rules) */
  userPb: PocketBase;
}

export interface TestUser {
  id: string;
  uid: string; // alias for id
  email: string;
  localId: string; // alias for id (Firebase compat)
}

/**
 * Initialize a PocketBase test context.
 * Creates the first superuser if none exists, then authenticates as admin.
 */
export async function initTestPocketBase(): Promise<TestContext> {
  const pb = new PocketBase(PB_TEST_URL);
  pb.autoCancellation(false);

  // Try to auth as existing superuser first
  try {
    await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  } catch {
    // First run — create the superuser
    try {
      await pb.collection("_superusers").create({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        passwordConfirm: ADMIN_PASSWORD,
      });
      await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
    } catch (e) {
      throw new Error(
        `Failed to initialize PocketBase test admin at ${PB_TEST_URL}. ` +
        `Is PocketBase running? (docker compose -f docker-compose.test.yml up -d)\n${e}`
      );
    }
  }

  const userPb = new PocketBase(PB_TEST_URL);
  userPb.autoCancellation(false);

  // Initialize the shared backend singleton so app code (getBackend()) works in tests
  initializeBackend(PB_TEST_URL);

  return { pb, testUser: null, userPb };
}

/**
 * Create a test user and sign in as them.
 */
export async function createTestUser(
  ctx: TestContext,
  overrides?: { email?: string; name?: string }
): Promise<TestUser> {
  const email = overrides?.email || `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const password = "testpassword123";

  const record = await ctx.pb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: overrides?.name || "Test User",
  });

  const user: TestUser = {
    id: record.id,
    uid: record.id,
    email,
    localId: record.id,
  };

  // Sign in both the user client and the shared backend singleton
  await ctx.userPb.collection("users").authWithPassword(email, password);
  const { getBackend } = await import("./backend");
  await getBackend().collection("users").authWithPassword(email, password);
  ctx.testUser = user;

  return user;
}

/**
 * Create a test user WITHOUT signing in as them.
 * Useful for multi-user tests.
 */
export async function createUserWithoutSignIn(ctx: TestContext): Promise<TestUser> {
  const email = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const password = "testpassword123";

  const record = await ctx.pb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: "Test User 2",
  });

  return {
    id: record.id,
    uid: record.id,
    email,
    localId: record.id,
  };
}

/**
 * Sign in as a specific test user.
 * Also authenticates the shared backend singleton so app functions work.
 */
export async function signInAsUser(ctx: TestContext, user: TestUser): Promise<void> {
  const password = "testpassword123";
  await ctx.userPb.collection("users").authWithPassword(user.email, password);
  // Also auth the shared singleton so app code (getBackend().authStore) works
  const { getBackend } = await import("./backend");
  await getBackend().collection("users").authWithPassword(user.email, password);
  ctx.testUser = user;
}

/**
 * Tracks created records for cleanup after each test.
 */
export class TestCleanup {
  private records: Array<{ collection: string; id: string }> = [];
  private adminPb: PocketBase | null = null;

  bind(pb: PocketBase) {
    this.adminPb = pb;
  }

  track(collectionName: string, id: string) {
    this.records.push({ collection: collectionName, id });
  }

  async cleanup() {
    if (!this.adminPb) return;
    // Delete in reverse order (children before parents)
    for (const rec of [...this.records].reverse()) {
      try {
        await this.adminPb.collection(rec.collection).delete(rec.id);
      } catch {
        // Already deleted or doesn't exist — fine
      }
    }
    this.records = [];
  }
}

/**
 * Clean up the test context. Deletes all test users created during the session.
 */
export async function cleanupTestPocketBase(ctx: TestContext): Promise<void> {
  // Delete all non-admin users created during testing
  try {
    const users = await ctx.pb.collection("users").getFullList({
      filter: 'email ~ "test.local"',
    });
    for (const user of users) {
      try {
        await ctx.pb.collection("users").delete(user.id);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

// ─── Shopping helpers ───────────────────────────────────────

export async function createTestList(
  ctx: TestContext,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    owners?: string[];
    categoryDefs?: Array<{ id: string; name: string; color: string }>;
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("shopping_lists").create({
    name: overrides?.name || "Test List",
    owners: overrides?.owners || [ctx.testUser!.id],
    category_defs: overrides?.categoryDefs || [],
  });
  cleanup.track("shopping_lists", record.id);
  return { id: record.id };
}

export async function createTestItem(
  ctx: TestContext,
  listId: string,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    categoryId?: string;
    checked?: boolean;
    note?: string;
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("shopping_items").create({
    list: listId,
    ingredient: overrides?.name !== undefined ? overrides.name : "Test Item",
    category_id: overrides?.categoryId || "uncategorized",
    checked: overrides?.checked || false,
    checked_by: overrides?.checked ? ctx.testUser!.id : "",
    added_by: ctx.testUser!.id,
    note: overrides?.note || "",
  });
  cleanup.track("shopping_items", record.id);
  return { id: record.id };
}

// ─── Life tracker helpers ───────────────────────────────────

export async function createTestLifeLog(
  ctx: TestContext,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    owners?: string[];
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("life_logs").create({
    name: overrides?.name || "Test Life Log",
    owners: overrides?.owners || [ctx.testUser!.id],
    manifest: { widgets: [] },
  });
  cleanup.track("life_logs", record.id);
  return { id: record.id };
}

export async function createTestEntry(
  ctx: TestContext,
  logId: string,
  cleanup: TestCleanup,
  overrides?: {
    type?: string;
    startTime?: string;
    endTime?: string | null;
    duration?: number | null;
    notes?: string;
  }
): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const record = await ctx.pb.collection("life_events").create({
    log: logId,
    subject_id: overrides?.type || "sleep",
    timestamp: overrides?.startTime || now,
    created_by: ctx.testUser!.id,
    data: {
      type: overrides?.type || "sleep",
      startTime: overrides?.startTime || now,
      endTime: overrides?.endTime !== undefined ? overrides.endTime : now,
      duration: overrides?.duration !== undefined ? overrides.duration : 30,
      notes: overrides?.notes || "",
    },
  });
  cleanup.track("life_events", record.id);
  return { id: record.id };
}

// ─── Upkeep helpers ─────────────────────────────────────────

export async function createTestTaskList(
  ctx: TestContext,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    owners?: string[];
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("task_lists").create({
    name: overrides?.name || "Test Task List",
    owners: overrides?.owners || [ctx.testUser!.id],
    room_defs: [],
  });
  cleanup.track("task_lists", record.id);
  return { id: record.id };
}

export async function createTestTask(
  ctx: TestContext,
  listId: string,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    roomId?: string;
    intervalDays?: number;
    frequency?: { value: number; unit: string };
    lastCompleted?: string | null;
    notifyUsers?: string[];
  }
): Promise<{ id: string }> {
  const freq = overrides?.frequency || {
    value: overrides?.intervalDays !== undefined ? overrides.intervalDays : 7,
    unit: "days",
  };
  const record = await ctx.pb.collection("tasks").create({
    list: listId,
    name: overrides?.name !== undefined ? overrides.name : "Test Task",
    room_id: overrides?.roomId || "general",
    frequency: freq,
    last_completed: overrides?.lastCompleted || null,
    notify_users: overrides?.notifyUsers || [],
  });
  cleanup.track("tasks", record.id);
  return { id: record.id };
}

// ─── Recipes helpers ────────────────────────────────────────

export async function createTestBox(
  ctx: TestContext,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    owners?: string[];
    visibility?: string;
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("recipe_boxes").create({
    name: overrides?.name || "Test Box",
    owners: overrides?.owners || [ctx.testUser!.id],
    visibility: overrides?.visibility || "private",
  });
  cleanup.track("recipe_boxes", record.id);
  return { id: record.id };
}

export async function createTestRecipe(
  ctx: TestContext,
  boxId: string,
  cleanup: TestCleanup,
  overrides?: {
    name?: string;
    data?: Record<string, unknown>;
    owners?: string[];
    visibility?: string;
  }
): Promise<{ id: string }> {
  const record = await ctx.pb.collection("recipes").create({
    box: boxId,
    data: {
      name: overrides?.name !== undefined ? overrides.name : "Test Recipe",
      ...overrides?.data,
    },
    owners: overrides?.owners || [ctx.testUser!.id],
    visibility: overrides?.visibility || "private",
    creator: ctx.testUser!.id,
  });
  cleanup.track("recipes", record.id);
  return { id: record.id };
}

export async function addBoxToUser(
  ctx: TestContext,
  userId: string,
  boxId: string
): Promise<void> {
  const user = await ctx.pb.collection("users").getOne(userId);
  const boxes = (user.recipe_boxes as string[]) || [];
  if (!boxes.includes(boxId)) {
    await ctx.pb.collection("users").update(userId, {
      recipe_boxes: [...boxes, boxId],
    });
  }
}

// ─── Utility ────────────────────────────────────────────────

export function testId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
