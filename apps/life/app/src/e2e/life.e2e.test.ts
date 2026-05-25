/**
 * Integration tests for the Life app using the @homelab/backend interface.
 *
 * Tests the PocketBase backend implementations against a real PocketBase instance.
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
import { PocketBaseLifeBackend } from "@homelab/backend/pocketbase";
import { wrapPocketBase, createMirror } from "@homelab/backend/wrapped-pb";

let ctx: TestContext;
let life: PocketBaseLifeBackend;

beforeAll(async () => {
  ctx = await initTestPocketBase();
  const pb = () => ctx.userPb;
  const wpb = wrapPocketBase(pb);
  life = new PocketBaseLifeBackend(pb, wpb, createMirror(pb, wpb));
});

afterAll(async () => {
  await cleanupTestPocketBase(ctx);
});

describe("getOrCreateLog", () => {
  it("creates a life log for a new user", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const result = await life.getOrCreateLog(user.id);

    expect(result.id).toBeTruthy();

    // Verify the back-pointer is set on the new log (life_logs.owner is the
    // source of truth post-0028/0029 — no forward pointer to keep in sync).
    const logRecord = await ctx.pb.collection("life_logs").getOne(result.id);
    expect(logRecord.owner).toBe(user.id);

    cleanup.track("life_logs", result.id);
    await cleanup.cleanup();
  });

  it("returns existing log if user already has one", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const first = await life.getOrCreateLog(user.id);
    cleanup.track("life_logs", first.id);

    const second = await life.getOrCreateLog(user.id);

    expect(second.id).toBe(first.id);

    await cleanup.cleanup();
  });
});

describe("addEvent", () => {
  it("creates a life event linked to the log", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await life.getOrCreateLog(user.id);
    const logId = log.id;
    cleanup.track("life_logs", logId);

    const eventId = await life.addEvent(
      logId,
      "vitamins",
      [{ name: "count", type: "number", value: 1, unit: "ct" }],
      user.id,
    );
    cleanup.track("life_events", eventId);

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(record.log).toBe(logId);
    expect(record.subject_id).toBe("vitamins");
    expect(record.created_by).toBe(user.id);
    expect(Array.isArray(record.entries)).toBe(true);
    expect(record.entries[0].name).toBe("count");
    expect(record.entries[0].value).toBe(1);

    await cleanup.cleanup();
  });

  it("stores text entries alongside numeric ones", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await life.getOrCreateLog(user.id);
    const logId = log.id;
    cleanup.track("life_logs", logId);

    const eventId = await life.addEvent(
      logId,
      "sleep",
      [
        { name: "duration", type: "number", value: 420, unit: "min" },
        { name: "notes", type: "text", value: "Felt rested" },
      ],
      user.id,
    );
    cleanup.track("life_events", eventId);

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    const entries = record.entries as Array<{ name: string; value: unknown }>;
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.name === "duration")?.value).toBe(420);
    expect(entries.find((e) => e.name === "notes")?.value).toBe("Felt rested");

    await cleanup.cleanup();
  });

  it("uses the provided timestamp", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await life.getOrCreateLog(user.id);
    const logId = log.id;
    cleanup.track("life_logs", logId);

    const ts = new Date("2025-01-15T10:00:00Z");
    const eventId = await life.addEvent(
      logId,
      "vitamins",
      [{ name: "count", type: "number", value: 1, unit: "ct" }],
      user.id,
      { timestamp: ts },
    );
    cleanup.track("life_events", eventId);

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(new Date(record.timestamp).toISOString()).toBe(ts.toISOString());

    await cleanup.cleanup();
  });

  it("persists labels.source on sample-shaped events", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await life.getOrCreateLog(user.id);
    const logId = log.id;
    cleanup.track("life_logs", logId);

    const eventId = await life.addEvent(
      logId,
      "mood",
      [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }],
      user.id,
      { labels: { source: "sample" } },
    );
    cleanup.track("life_events", eventId);

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect((record.labels as Record<string, string>).source).toBe("sample");

    await cleanup.cleanup();
  });
});

describe("updateEvent", () => {
  it("updates the timestamp on an existing event", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await life.getOrCreateLog(user.id);
    const logId = log.id;
    cleanup.track("life_logs", logId);

    const eventId = await life.addEvent(
      logId,
      "sleep",
      [{ name: "duration", type: "number", value: 360, unit: "min" }],
      user.id,
    );
    cleanup.track("life_events", eventId);

    const newTs = new Date("2025-03-01T08:00:00Z");
    await life.updateEvent(eventId, { timestamp: newTs });

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    expect(new Date(record.timestamp).toISOString()).toBe(newTs.toISOString());

    await cleanup.cleanup();
  });

  it("replaces the entries on an existing event", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await life.getOrCreateLog(user.id);
    const logId = log.id;
    cleanup.track("life_logs", logId);

    const eventId = await life.addEvent(
      logId,
      "sleep",
      [{ name: "duration", type: "number", value: 360, unit: "min" }],
      user.id,
    );
    cleanup.track("life_events", eventId);

    await life.updateEvent(eventId, {
      entries: [{ name: "duration", type: "number", value: 480, unit: "min" }],
    });

    const record = await ctx.pb.collection("life_events").getOne(eventId);
    const entries = record.entries as Array<{ name: string; value: number }>;
    expect(entries[0].value).toBe(480);

    await cleanup.cleanup();
  });
});

describe("deleteEvent", () => {
  it("deletes a life event", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await life.getOrCreateLog(user.id);
    const logId = log.id;
    cleanup.track("life_logs", logId);

    const eventId = await life.addEvent(
      logId,
      "vitamins",
      [{ name: "count", type: "number", value: 1, unit: "ct" }],
      user.id,
    );

    await life.deleteEvent(eventId);

    try {
      await ctx.pb.collection("life_events").getOne(eventId);
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.status).toBe(404);
    }

    await cleanup.cleanup();
  });
});

describe("clearSampleSchedule", () => {
  it("clears the sample_schedule field on a life log", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await life.getOrCreateLog(user.id);
    const logId = log.id;
    cleanup.track("life_logs", logId);

    // Set a sample schedule first
    await ctx.pb.collection("life_logs").update(logId, {
      sample_schedule: {
        date: "2025-01-15",
        times: [1736935200, 1736946000],
        sentTimes: [],
      },
    });

    await life.clearSampleSchedule(logId);

    const record = await ctx.pb.collection("life_logs").getOne(logId);
    expect(record.sample_schedule).toBeFalsy();

    await cleanup.cleanup();
  });
});
