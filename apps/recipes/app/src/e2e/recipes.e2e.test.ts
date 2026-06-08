/**
 * End-to-end tests for Recipes app using the @homelab/backend interface.
 *
 * Run with: npm test -- --run src/e2e
 * Requires PocketBase running: docker compose -f docker-compose.test.yml up -d
 */
// PocketBase realtime uses EventSource, which Node doesn't have. Polyfill once
// here so subscribe-based tests below work without a browser environment.
import { EventSource as NodeEventSource } from "eventsource";
if (typeof (globalThis as { EventSource?: unknown }).EventSource === "undefined") {
  (globalThis as { EventSource: unknown }).EventSource = NodeEventSource;
}

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initTestPocketBase,
  createTestUser,
  createUserWithoutSignIn,
  signInAsUser,
  cleanupTestPocketBase,
  TestCleanup,
  createTestBox,
  createTestRecipe,
  waitFor,
  type TestContext,
} from "@kirkl/shared/test-utils";
import { PocketBaseRecipesBackend, PocketBaseUserBackend } from "@homelab/backend/pocketbase";
import { wrapPocketBase, createMirror } from "@homelab/backend/wrapped-pb";
import type { CookingLogEvent } from "@homelab/backend";
import { EnrichmentStatus, Visibility } from "../types";

let ctx: TestContext;
let recipes: PocketBaseRecipesBackend;
let users: PocketBaseUserBackend;

beforeAll(async () => {
  ctx = await initTestPocketBase();
  const pb = () => ctx.userPb;
  const wpb = wrapPocketBase(pb);
  const mirror = createMirror(pb, wpb);
  recipes = new PocketBaseRecipesBackend(pb, wpb, mirror);
  users = new PocketBaseUserBackend(pb, wpb, mirror);
});

afterAll(async () => {
  await cleanupTestPocketBase(ctx);
});

// ─── Box Management ──────────────────────────────────────────────────────────

describe("createBox", () => {
  it("creates a recipe box and links it to the user", async () => {
    const user = await createTestUser(ctx);

    const boxId = await recipes.createBox(user.id, "My Recipes");
    expect(boxId).toBeTruthy();

    // Verify via admin client
    const boxRecord = await ctx.pb.collection("recipe_boxes").getOne(boxId);
    expect(boxRecord.name).toBe("My Recipes");
    expect(boxRecord.owners).toContain(user.id);
    expect(boxRecord.visibility).toBe(Visibility.private);

    // Verify user's recipe_boxes was updated
    const userRecord = await ctx.pb.collection("users").getOne(user.id);
    expect(userRecord.recipe_boxes).toContain(boxId);

    // Cleanup
    await ctx.pb.collection("recipe_boxes").delete(boxId);
  });
});

describe("deleteBox", () => {
  it("removes a recipe box via the backend", async () => {
    const user = await createTestUser(ctx);

    // Create box directly (not via TestCleanup since we'll delete it ourselves)
    const boxRecord = await ctx.pb.collection("recipe_boxes").create({
      name: "To Delete",
      owners: [user.id],
      visibility: "private",
    });

    await recipes.deleteBox(boxRecord.id);

    await expect(ctx.pb.collection("recipe_boxes").getOne(boxRecord.id)).rejects.toThrow();
  });
});

describe("setBoxVisibility", () => {
  it("changes a box from private to public", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Vis Box", visibility: "private" });

    await recipes.setBoxVisibility(box.id, Visibility.public);

    const record = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(record.visibility).toBe(Visibility.public);

    await cleanup.cleanup();
  });

  it("changes a box from public back to private", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Pub Box", visibility: "public" });

    await recipes.setBoxVisibility(box.id, Visibility.private);

    const record = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(record.visibility).toBe(Visibility.private);

    await cleanup.cleanup();
  });
});

// ─── User ─────────────────────────────────────────────────────────────────────

describe("getUser", () => {
  it("returns a user for an existing user", async () => {
    const user = await createTestUser(ctx);
    const userEntry = await recipes.getUser(user.id);

    expect(userEntry).not.toBeNull();
    expect(userEntry!.id).toBe(user.id);
  });

  it("returns null for a non-existent user", async () => {
    const result = await recipes.getUser("nonexistentid0000000");
    expect(result).toBeNull();
  });
});

// ─── resolveNames (user_names view) ─────────────────────────────────────────────

describe("resolveNames", () => {
  it("resolves display names via the user_names view, omits unknown ids, and leaks no PII", async () => {
    // Cross-app shared infra (Bug: cooking log says "Someone made this",
    // box co-owners render as "Anonymous"). resolveNames reads the read-only
    // `user_names` VIEW collection (id + name only) so any authenticated user
    // can resolve another user's display name without owner-only `users` access.
    //
    // This test fails without the 20260529_*_user_names_view.js migration:
    // querying a non-existent `user_names` collection throws.
    const userA = await createTestUser(ctx, { name: "Alice Resolver" });
    // Sign back in as userA so resolveNames runs as an authenticated user
    // (the view's listRule is `@request.auth.id != ""`).
    const userB = await createUserWithoutSignIn(ctx);
    await signInAsUser(ctx, userA);
    // Give userB a distinct, non-default name via admin so the assertion is
    // meaningful (createUserWithoutSignIn defaults to "Test User 2").
    await ctx.pb.collection("users").update(userB.id, { name: "Bob Resolver" });

    const rows = await users.resolveNames([userA.id, userB.id, "nonexistent000000"]);

    const byId = new Map(rows.map((r) => [r.id, r.name]));
    expect(byId.get(userA.id)).toBe("Alice Resolver");
    expect(byId.get(userB.id)).toBe("Bob Resolver");
    // Unknown ids are simply omitted, never present with an empty name.
    expect(byId.has("nonexistent000000")).toBe(false);
    expect(rows.length).toBe(2);

    // The view must expose ONLY id + name — never email or other PII.
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["id", "name"]);
      expect((r as Record<string, unknown>).email).toBeUndefined();
    }
  });

  it("returns an empty array for an empty id list (no network call)", async () => {
    const user = await createTestUser(ctx, { name: "Solo" });
    await signInAsUser(ctx, user);
    expect(await users.resolveNames([])).toEqual([]);
  });
});

// ─── Recipe Management ────────────────────────────────────────────────────────

describe("addRecipe", () => {
  it("creates a recipe in a box", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Recipe Box" });

    const recipeId = await recipes.addRecipe(box.id, {
      "@type": "Recipe",
      name: "Chocolate Cake",
      recipeIngredient: ["2 cups flour", "1 cup cocoa"],
    }, user.id);
    expect(recipeId).toBeTruthy();
    cleanup.track("recipes", recipeId);

    const record = await ctx.pb.collection("recipes").getOne(recipeId);
    expect(record.data.name).toBe("Chocolate Cake");
    expect(record.data.recipeIngredient).toHaveLength(2);
    expect(record.box).toBe(box.id);
    expect(record.owners).toContain(user.id);
    expect(record.enrichment_status).toBe(EnrichmentStatus.needed);

    await cleanup.cleanup();
  });
});

describe("saveRecipe", () => {
  it("updates a recipe and resets enrichment status", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Original Name" });

    await recipes.saveRecipe(recipe.id, {
      "@type": "Recipe",
      name: "Updated Name",
      description: "New description",
    }, user.id);

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.data.name).toBe("Updated Name");
    expect(record.enrichment_status).toBe(EnrichmentStatus.needed);
    expect(record.pending_changes).toBeNull();

    await cleanup.cleanup();
  });
});

describe("deleteRecipe", () => {
  it("removes a recipe from PocketBase", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });

    // Create recipe directly so cleanup won't try to re-delete it
    const recipeRecord = await ctx.pb.collection("recipes").create({
      box: box.id,
      data: { name: "To Delete" },
      owners: [user.id],
      visibility: "private",
      creator: user.id,
    });

    await recipes.deleteRecipe(recipeRecord.id);

    await expect(ctx.pb.collection("recipes").getOne(recipeRecord.id)).rejects.toThrow();

    await cleanup.cleanup();
  });
});

describe("setRecipeVisibility", () => {
  it("updates a recipe's visibility to public", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "My Recipe", visibility: "private" });

    await recipes.setRecipeVisibility(recipe.id, Visibility.public);

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.visibility).toBe(Visibility.public);

    await cleanup.cleanup();
  });
});

// ─── Box Subscription ─────────────────────────────────────────────────────────

describe("subscribeToBox / unsubscribeFromBox", () => {
  it("adds user to box subscribers and user's recipe_boxes list", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);
    await signInAsUser(ctx, userA);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    // Both users need to be owners for subscribeToBox to work (PB update rules)
    const box = await createTestBox(ctx, cleanup, { name: "Shared Box", owners: [userA.id, userB.id] });

    // Sign in as userB — subscribeToBox is called by the subscribing user
    await signInAsUser(ctx, userB);

    await recipes.subscribeToBox(userB.id, box.id);

    const boxRecord = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(boxRecord.subscribers).toContain(userB.id);

    const userBRecord = await ctx.pb.collection("users").getOne(userB.id);
    expect(userBRecord.recipe_boxes).toContain(box.id);

    await cleanup.cleanup();
  });

  it("removes user from box subscribers and user's recipe_boxes list", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);
    await signInAsUser(ctx, userA);

    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Shared Box", owners: [userA.id, userB.id] });

    // Sign in as userB for subscribe/unsubscribe
    await signInAsUser(ctx, userB);
    await recipes.subscribeToBox(userB.id, box.id);

    // Verify subscription was added
    const beforeRecord = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(beforeRecord.subscribers).toContain(userB.id);

    await recipes.unsubscribeFromBox(userB.id, box.id);

    const boxRecord = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(boxRecord.subscribers).not.toContain(userB.id);

    const userBRecord = await ctx.pb.collection("users").getOne(userB.id);
    expect(userBRecord.recipe_boxes).not.toContain(box.id);

    await cleanup.cleanup();
  });
});

// ─── Cooking Log Events ───────────────────────────────────────────────────────

describe("addCookingLogEvent / getCookingLogEvents", () => {
  it("adds a cooking log event and retrieves it", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Pasta" });

    const eventId = await recipes.addCookingLogEvent(box.id, recipe.id, user.id, { notes: "Great batch!" });
    cleanup.track("recipe_events", eventId);

    const events = await recipes.getCookingLogEvents(box.id, recipe.id);
    expect(events.length).toBe(1);
    const notesEntry = events[0].entries.find((e) => e.name === "notes" && e.type === "text");
    expect(notesEntry?.type === "text" && notesEntry.value).toBe("Great batch!");

    await cleanup.cleanup();
  });

  it("adds multiple cooking log events", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Pizza" });

    const id1 = await recipes.addCookingLogEvent(box.id, recipe.id, user.id, { notes: "First time" });
    const id2 = await recipes.addCookingLogEvent(box.id, recipe.id, user.id, { notes: "Second time" });
    cleanup.track("recipe_events", id1);
    cleanup.track("recipe_events", id2);

    const events = await recipes.getCookingLogEvents(box.id, recipe.id);
    expect(events.length).toBe(2);

    await cleanup.cleanup();
  });

  it("returns empty array when no events exist", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Soup" });

    const events = await recipes.getCookingLogEvents(box.id, recipe.id);
    expect(events).toEqual([]);

    await cleanup.cleanup();
  });
});

describe("updateCookingLogEvent", () => {
  it("updates the notes on an event", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Stew" });

    const eventId = await recipes.addCookingLogEvent(box.id, recipe.id, user.id, { notes: "Original notes" });
    cleanup.track("recipe_events", eventId);

    await recipes.updateCookingLogEvent(eventId, "Updated notes");

    const record = await ctx.pb.collection("recipe_events").getOne(eventId);
    const updatedNote = (record.entries as Array<Record<string, unknown>>).find(
      (e) => e.name === "notes" && e.type === "text",
    );
    expect(updatedNote?.value).toBe("Updated notes");

    await cleanup.cleanup();
  });

  it("removes notes when updated with empty string", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Stew" });

    const eventId = await recipes.addCookingLogEvent(box.id, recipe.id, user.id, { notes: "Some notes" });
    cleanup.track("recipe_events", eventId);

    await recipes.updateCookingLogEvent(eventId, "   ");

    const record = await ctx.pb.collection("recipe_events").getOne(eventId);
    const cleared = (record.entries as Array<Record<string, unknown>>).find(
      (e) => e.name === "notes" && e.type === "text",
    );
    expect(cleared).toBeUndefined();

    await cleanup.cleanup();
  });
});

describe("deleteCookingLogEvent", () => {
  it("removes a cooking log event", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Roast" });

    const eventId = await recipes.addCookingLogEvent(box.id, recipe.id, user.id);

    await recipes.deleteCookingLogEvent(eventId);

    await expect(ctx.pb.collection("recipe_events").getOne(eventId)).rejects.toThrow();

    await cleanup.cleanup();
  });
});

// SSE round-trips (register subscription, broadcast, deliver) are inherently
// async and slow down sharply under CPU contention — e.g. when several e2e
// suites hammer one PB during the deploy gate. The structural flake (events
// broadcast before the subscribe POST registers are dropped, never replayed) is
// handled by the liveness warmup probe below; this generous budget just absorbs
// the extra latency so a slow-but-correct delivery isn't misread as a failure.
const SSE_DELIVERY_TIMEOUT = 15000;

describe("subscribeToCookingLog", () => {
  // This test does several sequential SSE round-trips — initial replay, a warmup
  // probe loop that may retry for up to SSE_DELIVERY_TIMEOUT, then the real
  // out-of-band create and its delete — each allowed SSE_DELIVERY_TIMEOUT to
  // absorb load-induced latency. Those can't fit the suite-wide 30s per-test
  // budget, so give this one test a wider budget (the 90000 below). In a healthy
  // run the whole thing finishes in ~1.5s; the budget only matters when the
  // deploy gate's CPU contention slows SSE registration and delivery.
  it("emits initial events on subscribe and live-updates on new adds (no remount needed)", async () => {
    // Smoking gun for Bug 1: CookingLog.tsx mounts once and never re-fetches.
    // This test pins the contract that the backend's subscribeToCookingLog
    // fires for both initial state AND subsequent writes from a separate
    // source, so the UI can replace its one-shot useEffect.
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    // `createTestUser` re-authenticates the shared `ctx.userPb` as a brand-new
    // user — an auth IDENTITY change. The PB SDK keeps ONE realtime clientId per
    // SDK instance, so any SSE connection left open by the 34 prior tests in
    // this file is bound to the previous identity's clientId. Reusing it makes
    // the next subscribe POST race a stale clientId: registration can land as
    // 403 ("authorization don't match") and silently never deliver, so the
    // out-of-band events below are lost forever and the test times out. The app
    // does this disconnect-on-identity-change automatically; the suite-shared
    // SDK in this test harness does not, so we do it explicitly here. Without
    // it, the test passes in `-t` isolation but flakes hard after a full run.
    //
    // `unsubscribe()` (no topic) drops every subscription and tears down the SSE
    // connection, so the mirror's subscribe below opens a fresh one under the new
    // identity. We await it so the teardown completes before that subscribe — a
    // fire-and-forget would race it. `.catch` swallows the benign 404 the DELETE
    // /api/realtime returns when there's no live connection to drop (e.g. this
    // test running first); a real failure would still surface as the subsequent
    // subscribe never delivering, which the warmup probe below detects.
    await ctx.userPb.realtime.unsubscribe().catch(() => {});

    const box = await createTestBox(ctx, cleanup, { name: "Sub Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Roast" });

    // Pre-existing event to verify initial replay
    const seedId = await recipes.addCookingLogEvent(box.id, recipe.id, user.id, { notes: "Seed" });
    cleanup.track("recipe_events", seedId);

    let lastBatch: CookingLogEvent[] = [];
    let callbackCount = 0;
    const unsub = recipes.subscribeToCookingLog(box.id, recipe.id, (events) => {
      lastBatch = events;
      callbackCount++;
    });

    // Notes live as a "notes" text entry in the unified shape.
    const noteOf = (e: CookingLogEvent): string | undefined => {
      for (const entry of e.entries) {
        if (entry.name === "notes" && entry.type === "text") return entry.value;
      }
      return undefined;
    };

    // Wait for initial delivery
    await waitFor(() => callbackCount >= 1 && lastBatch.length === 1, SSE_DELIVERY_TIMEOUT);
    expect(noteOf(lastBatch[0])).toBe("Seed");

    // ── Liveness warmup probe ──────────────────────────────────────────────
    // The mirror delivers initial state off `getFullList` (the callback above)
    // and attaches its SSE listener fire-and-forget. So a passing initial
    // callback does NOT mean the realtime subscription is registered — the SSE
    // connection may still be coming up (clientId still empty) when we issue an
    // out-of-band write. PocketBase does NOT replay events broadcast before
    // registration, so any create that beats registration is dropped forever and
    // the assertion times out. This is the SSE-registration race; under CPU load
    // (the deploy gate) it loses reliably. The real fix lives in the mirror
    // (await registration before resolving the watch) and is a separate, harder
    // track — here we make the TEST honest about waiting for the channel to be
    // live before producing the event it expects to receive over SSE.
    //
    // We can't just wait on `clientId` becoming non-empty: that signals the SSE
    // socket connected, not that THIS subscription is registered server-side, and
    // a create can still slip into the gap. The robust, internals-free proof is
    // to keep issuing a throwaway out-of-band create and waiting a short beat for
    // the subscriber callback to see it; the first probe that comes back proves
    // the channel is registered AND delivering. Probes that race registration are
    // simply lost — we delete them and retry. Do NOT replace this with a fixed
    // sleep: that's the exact load-sensitive thing that made this test flaky.
    const probeNote = "Warmup probe";
    let warmedUp = false;
    const warmupDeadline = Date.now() + SSE_DELIVERY_TIMEOUT;
    while (Date.now() < warmupDeadline) {
      const probeRec = await ctx.pb.collection("recipe_events").create({
        box: box.id,
        subject_id: recipe.id,
        timestamp: new Date().toISOString(),
        created_by: user.id,
        entries: [{ name: "notes", type: "text", value: probeNote }],
      });
      try {
        await waitFor(() => lastBatch.some((e) => noteOf(e) === probeNote), 1000, 50);
        warmedUp = true;
      } catch {
        // This probe raced registration and was lost; fall through to delete +
        // retry until one is delivered or the deadline passes.
      }
      await ctx.pb.collection("recipe_events").delete(probeRec.id);
      if (warmedUp) break;
    }
    expect(warmedUp).toBe(true);
    // Wait until the (delivered) probe deletion has propagated so it can't
    // perturb the length-based assertions below (which expect exactly Seed, then
    // Seed + the real event).
    await waitFor(() => callbackCount >= 1 && lastBatch.length === 1, SSE_DELIVERY_TIMEOUT);
    expect(noteOf(lastBatch[0])).toBe("Seed");

    // Simulate "another device" / out-of-band write: add via the admin client
    // directly, bypassing the local wpb cache. The subscription must catch it
    // via realtime SSE.
    const newRec = await ctx.pb.collection("recipe_events").create({
      box: box.id,
      subject_id: recipe.id,
      timestamp: new Date().toISOString(),
      created_by: user.id,
      entries: [{ name: "notes", type: "text", value: "From another tab" }],
    });
    cleanup.track("recipe_events", newRec.id);

    await waitFor(() => lastBatch.length === 2, SSE_DELIVERY_TIMEOUT);
    expect(lastBatch.map(noteOf)).toContain("From another tab");
    expect(lastBatch.map(noteOf)).toContain("Seed");

    // Delete via the same backend instance — subscription should drop it
    await recipes.deleteCookingLogEvent(newRec.id);
    await waitFor(() => lastBatch.length === 1, SSE_DELIVERY_TIMEOUT);
    expect(noteOf(lastBatch[0])).toBe("Seed");

    unsub();
    await cleanup.cleanup();
  }, 90000);
});

// ─── Pending Changes ──────────────────────────────────────────────────────────

describe("applyChanges", () => {
  it("applies enrichment changes to recipe data and sets status to done", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, {
      name: "Basic Soup",
      data: { recipeIngredient: ["water"] },
    });

    const changes = {
      data: {
        name: "Enriched Soup",
        description: "A rich, hearty soup",
        recipeIngredient: ["water", "1 onion", "2 carrots"],
      },
      source: "enrichment" as const,
      reasoning: "Added ingredients",
      generatedAt: new Date().toISOString(),
      model: "test-model",
    };

    await recipes.applyChanges(recipe.id, changes);

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.data.name).toBe("Enriched Soup");
    expect(record.data.description).toBe("A rich, hearty soup");
    expect(record.data.recipeIngredient).toHaveLength(3);
    expect(record.enrichment_status).toBe(EnrichmentStatus.done);
    expect(record.pending_changes).toBeNull();

    await cleanup.cleanup();
  });

  it("applies modification changes and re-queues enrichment", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Plain Chicken" });

    const changes = {
      data: {
        name: "Spiced Chicken",
        recipeInstructions: [{ "@type": "HowToStep" as const, text: "Season with spices" }],
      },
      source: "modification" as const,
      reasoning: "User requested spice",
      prompt: "add spices",
      generatedAt: new Date().toISOString(),
      model: "test-model",
    };

    await recipes.applyChanges(recipe.id, changes);

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.data.name).toBe("Spiced Chicken");
    expect(record.enrichment_status).toBe(EnrichmentStatus.needed);
    expect(record.pending_changes).toBeNull();

    await cleanup.cleanup();
  });

  it("merges tags from recipeCategory into existing tags", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Chicken Soup" });
    // Set initial tags via admin client
    await ctx.pb.collection("recipes").update(recipe.id, {
      data: { name: "Chicken Soup", recipeCategory: ["soup"] },
    });

    const changes = {
      data: {
        recipeCategory: ["dinner", "soup"],
      },
      source: "enrichment" as const,
      reasoning: "Added categories",
      generatedAt: new Date().toISOString(),
      model: "test-model",
    };

    await recipes.applyChanges(recipe.id, changes, { tags: ["soup"] });

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    // Tags merged and deduplicated
    expect(record.data.recipeCategory).toContain("soup");
    expect(record.data.recipeCategory).toContain("dinner");

    await cleanup.cleanup();
  });
});

describe("rejectChanges", () => {
  it("clears pending_changes without changing enrichment status for non-enrichment source", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Recipe" });

    // Add pending changes via admin
    await ctx.pb.collection("recipes").update(recipe.id, {
      pending_changes: {
        data: { name: "Proposed Name" },
        source: "modification",
        reasoning: "test",
        generatedAt: new Date().toISOString(),
        model: "test",
      },
    });

    await recipes.rejectChanges(recipe.id, "modification");

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.pending_changes).toBeNull();
    expect(record.enrichment_status).not.toBe(EnrichmentStatus.skipped);

    await cleanup.cleanup();
  });

  it("clears pending_changes and sets enrichment_status to skipped for enrichment source", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Box" });
    const recipe = await createTestRecipe(ctx, box.id, cleanup, { name: "Recipe" });

    // Add pending enrichment changes via admin
    await ctx.pb.collection("recipes").update(recipe.id, {
      pending_changes: {
        data: { description: "Enriched description" },
        source: "enrichment",
        reasoning: "enrichment test",
        generatedAt: new Date().toISOString(),
        model: "test",
      },
    });

    await recipes.rejectChanges(recipe.id, "enrichment");

    const record = await ctx.pb.collection("recipes").getOne(recipe.id);
    expect(record.pending_changes).toBeNull();
    expect(record.enrichment_status).toBe(EnrichmentStatus.skipped);

    await cleanup.cleanup();
  });
});

// ─── getBox ───────────────────────────────────────────────────────────────────

describe("getBox", () => {
  it("returns a box with recipes", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Fetched Box" });
    await createTestRecipe(ctx, box.id, cleanup, { name: "Recipe A" });
    await createTestRecipe(ctx, box.id, cleanup, { name: "Recipe B" });

    const result = await recipes.getBox(box.id, user.id);
    expect(result).not.toBeNull();
    expect(result!.box.name).toBe("Fetched Box");
    expect(result!.recipes.length).toBe(2);

    await cleanup.cleanup();
  });

  it("returns null for non-existent box", async () => {
    const result = await recipes.getBox("nonexistentboxid0000", null);
    expect(result).toBeNull();
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe("User edge cases", () => {
  it("handles user with no recipe_boxes", async () => {
    const user = await createUserWithoutSignIn(ctx);
    await signInAsUser(ctx, user);

    const userEntry = await recipes.getUser(user.id);
    expect(userEntry).not.toBeNull();
    expect(userEntry!.boxes.length).toBe(0);
  });

  it("scrubs stale box reference from user when box is deleted", async () => {
    // The recipe-box-cleanup.pb.js hook (shipped 2026-05-20, commit dba9a96)
    // listens for recipe_boxes deletes and removes the deleted id from every
    // user's recipe_boxes JSON array. Without it, each dangling entry produces
    // a 404 from the recipes app's per-box fetch on every page load. This test
    // pins that behavior so a future hook regression is caught here.
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const boxId = await recipes.createBox(user.id, "Box To Delete");
    expect(boxId).toBeTruthy();

    // Verify it's in user's list
    const beforeRecord = await ctx.pb.collection("users").getOne(user.id);
    expect(beforeRecord.recipe_boxes).toContain(boxId);

    // Delete the box directly (bypassing deleteBox so the cleanup is purely
    // the hook's doing, not application-layer bookkeeping).
    await ctx.pb.collection("recipe_boxes").delete(boxId);

    // Hook scrubs the dangling reference from the user's recipe_boxes array.
    const afterRecord = await ctx.pb.collection("users").getOne(user.id);
    expect(afterRecord.recipe_boxes).not.toContain(boxId);

    // getBox returns null for deleted box
    const result = await recipes.getBox(boxId, user.id);
    expect(result).toBeNull();

    await cleanup.cleanup();
  });
});

describe("Box access control", () => {
  it("prevents non-owner from deleting box via userPb", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);

    const box = await ctx.pb.collection("recipe_boxes").create({
      name: "Owner Only Box",
      owners: [userA.id],
      visibility: "private",
    });

    await signInAsUser(ctx, userB);
    await expect(
      ctx.userPb.collection("recipe_boxes").delete(box.id)
    ).rejects.toThrow();

    // Cleanup via admin
    await ctx.pb.collection("recipe_boxes").delete(box.id);
  });
});

// ─── Sharing Invites ─────────────────────────────────────────────────────────

describe("Sharing invites", () => {
  it("owner can create an invite for their box", async () => {
    const userA = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const box = await createTestBox(ctx, cleanup, { name: "Invite Box" });

    // Create invite as the owner (userA is signed in)
    const invite = await ctx.userPb.collection("sharing_invites").create({
      code: `test-${Date.now()}`,
      target_type: "box",
      target_id: box.id,
      created_by: userA.id,
      redeemed: false,
    });
    cleanup.track("sharing_invites", invite.id);

    expect(invite.code).toBeTruthy();
    expect(invite.target_type).toBe("box");
    expect(invite.target_id).toBe(box.id);

    await cleanup.cleanup();
  });

  it("non-owner cannot create an invite (hook blocks it)", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);

    const box = await ctx.pb.collection("recipe_boxes").create({
      name: "Not My Box",
      owners: [userA.id],
      visibility: "private",
    });

    // Sign in as userB (not an owner)
    await signInAsUser(ctx, userB);
    await expect(
      ctx.userPb.collection("sharing_invites").create({
        code: `test-${Date.now()}`,
        target_type: "box",
        target_id: box.id,
        created_by: userB.id,
        redeemed: false,
      })
    ).rejects.toThrow();

    // Cleanup
    await ctx.pb.collection("recipe_boxes").delete(box.id);
  });

  it("redeem invite adds user to box owners", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);

    // Create box as userA
    const box = await ctx.pb.collection("recipe_boxes").create({
      name: "Shared Box",
      owners: [userA.id],
      visibility: "private",
    });

    // Create invite as userA (who owns the box)
    await signInAsUser(ctx, userA);
    const code = `invite-${Date.now()}`;
    const invite = await ctx.userPb.collection("sharing_invites").create({
      code,
      target_type: "box",
      target_id: box.id,
      created_by: userA.id,
      redeemed: false,
    });

    // Sign in as userB and redeem via the custom hook endpoint
    await signInAsUser(ctx, userB);
    const response = await ctx.userPb.send("/api/sharing/redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.success).toBe(true);

    // Verify userB is now an owner
    const updatedBox = await ctx.pb.collection("recipe_boxes").getOne(box.id);
    expect(updatedBox.owners).toContain(userB.id);

    // Verify invite is marked redeemed
    const updatedInvite = await ctx.pb.collection("sharing_invites").getOne(invite.id);
    expect(updatedInvite.redeemed).toBe(true);
    expect(updatedInvite.redeemed_by).toBe(userB.id);

    // Cleanup
    await ctx.pb.collection("sharing_invites").delete(invite.id);
    await ctx.pb.collection("recipe_boxes").delete(box.id);
  });

  it("cannot redeem an already-redeemed invite", async () => {
    const userA = await createUserWithoutSignIn(ctx);
    const userB = await createUserWithoutSignIn(ctx);

    const box = await ctx.pb.collection("recipe_boxes").create({
      name: "Once Only Box",
      owners: [userA.id],
      visibility: "private",
    });

    // Create invite as userA (owner), then mark as redeemed via admin
    await signInAsUser(ctx, userA);
    const code = `once-${Date.now()}`;
    const invite = await ctx.userPb.collection("sharing_invites").create({
      code,
      target_type: "box",
      target_id: box.id,
      created_by: userA.id,
      redeemed: false,
    });
    // Mark as redeemed via admin
    await ctx.pb.collection("sharing_invites").update(invite.id, { redeemed: true });

    await signInAsUser(ctx, userB);
    await expect(
      ctx.userPb.send("/api/sharing/redeem", {
        method: "POST",
        body: JSON.stringify({ code }),
        headers: { "Content-Type": "application/json" },
      })
    ).rejects.toThrow();

    // Cleanup
    await ctx.pb.collection("sharing_invites").delete(invite.id);
    await ctx.pb.collection("recipe_boxes").delete(box.id);
  });
});
