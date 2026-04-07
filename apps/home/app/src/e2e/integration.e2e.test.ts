/**
 * Integration tests for the Home app shell — PocketBase backend.
 *
 * The home app is a shell that embeds shopping, life, recipes, upkeep, and travel
 * as modules. These tests verify that:
 *   1. The shared backend initializes correctly.
 *   2. User profile fields required by each module exist and work.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initTestPocketBase,
  cleanupTestPocketBase,
  createTestUser,
  TestCleanup,
  type TestContext,
} from "@kirkl/shared/test-utils";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await initTestPocketBase();
});

afterAll(async () => {
  await cleanupTestPocketBase(ctx);
});

describe("Shared backend initialization", () => {
  it("connects and authenticates to PocketBase", async () => {
    // If initTestPocketBase succeeded, the connection is working.
    // Verify by reading any collection without error.
    const users = await ctx.pb.collection("users").getFullList({ filter: 'email = "nobody@nowhere.invalid"' });
    expect(Array.isArray(users)).toBe(true);
  });
});

describe("User profile fields across modules", () => {
  it("user record has shopping_slugs field", async () => {
    const user = await createTestUser(ctx);
    const record = await ctx.pb.collection("users").getOne(user.id);
    expect(record).toHaveProperty("shopping_slugs");
  });

  it("user record has household_slugs field", async () => {
    const user = await createTestUser(ctx);
    const record = await ctx.pb.collection("users").getOne(user.id);
    expect(record).toHaveProperty("household_slugs");
  });

  it("user record has life_log_id field", async () => {
    const user = await createTestUser(ctx);
    const record = await ctx.pb.collection("users").getOne(user.id);
    expect(record).toHaveProperty("life_log_id");
  });

  it("user record has recipe_boxes field", async () => {
    const user = await createTestUser(ctx);
    const record = await ctx.pb.collection("users").getOne(user.id);
    expect(record).toHaveProperty("recipe_boxes");
  });

  it("user record has travel_slugs field", async () => {
    const user = await createTestUser(ctx);
    const record = await ctx.pb.collection("users").getOne(user.id);
    expect(record).toHaveProperty("travel_slugs");
  });

  it("shopping_slugs can be set and read back", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    await ctx.pb.collection("users").update(user.id, {
      shopping_slugs: ["my-list", "family-shop"],
    });
    const record = await ctx.pb.collection("users").getOne(user.id);
    expect(record.shopping_slugs).toContain("my-list");
    expect(record.shopping_slugs).toContain("family-shop");

    await cleanup.cleanup();
  });

  it("life_log_id can be set and read back", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await ctx.pb.collection("life_logs").create({
      name: "Test Log",
      owners: [user.id],
      manifest: { widgets: [] },
    });
    cleanup.track("life_logs", log.id);

    await ctx.pb.collection("users").update(user.id, { life_log_id: log.id });
    const record = await ctx.pb.collection("users").getOne(user.id);
    expect(record.life_log_id).toBe(log.id);

    await cleanup.cleanup();
  });

  it("recipe_boxes can be set and read back", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await ctx.pb.collection("recipe_boxes").create({
      name: "Test Box",
      owners: [user.id],
      visibility: "private",
    });
    cleanup.track("recipe_boxes", box.id);

    await ctx.pb.collection("users").update(user.id, { recipe_boxes: [box.id] });
    const record = await ctx.pb.collection("users").getOne(user.id);
    expect(record.recipe_boxes).toContain(box.id);
    expect(typeof record.recipe_boxes[0]).toBe("string");

    await cleanup.cleanup();
  });

  it("travel_slugs can be set and read back", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log = await ctx.pb.collection("travel_logs").create({
      name: "My Trips",
      owners: [user.id],
      checklists: [],
    });
    cleanup.track("travel_logs", log.id);

    await ctx.pb.collection("users").update(user.id, { travel_slugs: { "my-trips": log.id } });
    const record = await ctx.pb.collection("users").getOne(user.id);
    expect(record.travel_slugs["my-trips"]).toBe(log.id);

    await cleanup.cleanup();
  });
});
