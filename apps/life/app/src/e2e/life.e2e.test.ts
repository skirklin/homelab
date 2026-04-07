/**
 * Integration tests for the Life app — tests actual app functions from pocketbase.ts.
 *
 * App functions use getBackend() internally; initTestPocketBase() initializes the
 * shared backend singleton so all calls go to the test PocketBase instance.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Stub localStorage for Node.js environment
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
});
import {
  initTestPocketBase,
  cleanupTestPocketBase,
  createTestUser,
  TestCleanup,
  type TestContext,
} from "@kirkl/shared/test-utils";
import {
  getOrCreateUserLog,
  addEntry,
  updateEntry,
  deleteEntry,
  updateManifest,
  addSampleResponse,
  clearSampleSchedule,
  setCurrentLogId,
} from "../pocketbase";
import { DEFAULT_MANIFEST } from "../types";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await initTestPocketBase();
});

afterAll(async () => {
  await cleanupTestPocketBase(ctx);
});

describe("getOrCreateUserLog", () => {
  it("creates a life log for a new user", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const result = await getOrCreateUserLog(user.id);

    expect(result.id).toBeTruthy();
    expect(result.data.name).toBe("Life Log");
    expect(result.data.owners).toContain(user.id);

    // Verify user record was updated with the log ID
    const userRecord = await ctx.pb.collection("users").getOne(user.id);
    expect(userRecord.life_log_id).toBe(result.id);

    cleanup.track("life_logs", result.id);
    await cleanup.cleanup();
  });

  it("returns existing log if user already has one", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const first = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", first.id);

    const second = await getOrCreateUserLog(user.id);

    expect(second.id).toBe(first.id);

    await cleanup.cleanup();
  });

  it("creates a new log when existing life_log_id is stale", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    // Point the user at a nonexistent log ID
    await ctx.pb.collection("users").update(user.id, { life_log_id: "nonexistent000000000" });

    const result = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", result.id);

    expect(result.id).toBeTruthy();
    expect(result.id).not.toBe("nonexistent000000000");

    await cleanup.cleanup();
  });
});

describe("addEntry", () => {
  it("creates a life event linked to the current log", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const { id: logId } = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", logId);
    setCurrentLogId(logId);

    const eventId = await addEntry("meds", { count: 1 }, user.id);
    cleanup.track("life_events", eventId);

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(record.log).toBe(logId);
    expect(record.subject_id).toBe("meds");
    expect(record.created_by).toBe(user.id);
    expect(record.data.count).toBe(1);

    await cleanup.cleanup();
  });

  it("stores notes and source in the data field", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const { id: logId } = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", logId);
    setCurrentLogId(logId);

    const eventId = await addEntry("sleep", { hours: 7 }, user.id, {
      notes: "Felt rested",
      source: "manual",
    });
    cleanup.track("life_events", eventId);

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(record.data.notes).toBe("Felt rested");
    expect(record.data.source).toBe("manual");
    expect(record.data.hours).toBe(7);

    await cleanup.cleanup();
  });

  it("uses the provided timestamp", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const { id: logId } = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", logId);
    setCurrentLogId(logId);

    const ts = new Date("2025-01-15T10:00:00Z");
    const eventId = await addEntry("vitamins", {}, user.id, { timestamp: ts });
    cleanup.track("life_events", eventId);

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(new Date(record.timestamp).toISOString()).toBe(ts.toISOString());

    await cleanup.cleanup();
  });

  it("accepts explicit logId override", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    // Create two logs; use the second via logId option, not setCurrentLogId
    const { id: logId1 } = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", logId1);

    const log2 = await ctx.pb.collection("life_logs").create({
      name: "Second Log",
      owners: [user.id],
      manifest: DEFAULT_MANIFEST,
    });
    cleanup.track("life_logs", log2.id);

    setCurrentLogId(logId1);

    const eventId = await addEntry("meds", {}, user.id, { logId: log2.id });
    cleanup.track("life_events", eventId);

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(record.log).toBe(log2.id);

    await cleanup.cleanup();
  });
});

describe("updateEntry", () => {
  it("updates the timestamp on an existing event", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const { id: logId } = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", logId);
    setCurrentLogId(logId);

    const eventId = await addEntry("sleep", { hours: 6 }, user.id);
    cleanup.track("life_events", eventId);

    const newTs = new Date("2025-03-01T08:00:00Z");
    await updateEntry(eventId, { timestamp: newTs });

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(new Date(record.timestamp).toISOString()).toBe(newTs.toISOString());

    await cleanup.cleanup();
  });

  it("updates the data on an existing event", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const { id: logId } = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", logId);
    setCurrentLogId(logId);

    const eventId = await addEntry("sleep", { hours: 6 }, user.id);
    cleanup.track("life_events", eventId);

    await updateEntry(eventId, { data: { hours: 8 } });

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(record.data.hours).toBe(8);

    await cleanup.cleanup();
  });

  it("merges notes into existing data when only notes are updated", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const { id: logId } = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", logId);
    setCurrentLogId(logId);

    const eventId = await addEntry("meds", { count: 1 }, user.id);
    cleanup.track("life_events", eventId);

    await updateEntry(eventId, { notes: "Took with food" });

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(record.data.notes).toBe("Took with food");
    // Original data should be preserved
    expect(record.data.count).toBe(1);

    await cleanup.cleanup();
  });
});

describe("deleteEntry", () => {
  it("deletes a life event", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const { id: logId } = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", logId);
    setCurrentLogId(logId);

    const eventId = await addEntry("vitamins", {}, user.id);

    await deleteEntry(eventId);

    try {
      await ctx.pb.collection("life_events").getOne(eventId);
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.status).toBe(404);
    }

    await cleanup.cleanup();
  });
});

describe("updateManifest", () => {
  it("updates the manifest on a life log", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const { id: logId } = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", logId);
    setCurrentLogId(logId);

    const newManifest = {
      ...DEFAULT_MANIFEST,
      widgets: [
        { id: "meds", type: "counter" as const, label: "Meds" },
        { id: "mood", type: "rating" as const, label: "Mood", max: 5 },
      ],
    };

    await updateManifest(newManifest);

    const record = await ctx.pb.collection("life_logs").getOne(logId);
    expect(record.manifest.widgets).toHaveLength(2);
    expect(record.manifest.widgets[1].id).toBe("mood");

    await cleanup.cleanup();
  });

  it("accepts explicit logId override", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await ctx.pb.collection("life_logs").create({
      name: "Override Log",
      owners: [user.id],
      manifest: DEFAULT_MANIFEST,
    });
    cleanup.track("life_logs", log.id);

    const updatedManifest = {
      ...DEFAULT_MANIFEST,
      widgets: [{ id: "custom", type: "counter" as const, label: "Custom" }],
    };

    await updateManifest(updatedManifest, log.id);

    const record = await ctx.pb.collection("life_logs").getOne(log.id);
    expect(record.manifest.widgets[0].id).toBe("custom");

    await cleanup.cleanup();
  });
});

describe("addSampleResponse", () => {
  it("creates a sample event with __sample__ subject_id", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const { id: logId } = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", logId);
    setCurrentLogId(logId);

    const eventId = await addSampleResponse({ mood: 4, energy: 3 }, user.id);
    cleanup.track("life_events", eventId);

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(record.subject_id).toBe("__sample__");
    expect(record.data.mood).toBe(4);
    expect(record.data.energy).toBe(3);
    expect(record.data.source).toBe("sample");
    expect(record.created_by).toBe(user.id);

    await cleanup.cleanup();
  });

  it("accepts explicit logId override", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await ctx.pb.collection("life_logs").create({
      name: "Sample Override Log",
      owners: [user.id],
      manifest: DEFAULT_MANIFEST,
    });
    cleanup.track("life_logs", log.id);

    const eventId = await addSampleResponse({ mood: 5 }, user.id, log.id);
    cleanup.track("life_events", eventId);

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(record.log).toBe(log.id);

    await cleanup.cleanup();
  });
});

describe("clearSampleSchedule", () => {
  it("clears the sample_schedule field on a life log", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const { id: logId } = await getOrCreateUserLog(user.id);
    cleanup.track("life_logs", logId);
    setCurrentLogId(logId);

    // Set a sample schedule first
    await ctx.pb.collection("life_logs").update(logId, {
      sample_schedule: {
        date: "2025-01-15",
        times: [1736935200, 1736946000],
        sentTimes: [],
      },
    });

    await clearSampleSchedule();

    const record = await ctx.pb.collection("life_logs").getOne(logId);
    expect(record.sample_schedule).toBeFalsy();

    await cleanup.cleanup();
  });
});

describe("requireLogId error handling", () => {
  it("throws when no log ID is set and none is provided", async () => {
    await createTestUser(ctx);

    // Explicitly clear the current log ID
    setCurrentLogId(null);

    await expect(addEntry("meds", {}, "someuserid")).rejects.toThrow("No log ID set");
  });
});
