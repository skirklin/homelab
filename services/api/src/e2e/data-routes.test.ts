/**
 * E2E tests for all data routes (the endpoints the MCP server calls).
 * Happy-path coverage for every endpoint in routes/data.ts.
 *
 * Requires: PocketBase running on localhost:8091 (docker-compose.test.yml)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import PocketBase from "pocketbase";

// Set env before dynamic import
process.env.PB_URL = "http://127.0.0.1:8091";
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const { default: { app } } = await import("../test-app");

const PB_URL = "http://127.0.0.1:8091";

let adminPb: PocketBase;
let userId: string;
let userToken: string;

// Test data IDs — populated in beforeAll
let recipeBoxId: string;
let recipe1Id: string;
let recipe2Id: string;
let shoppingListId: string;
let shoppingItem1Id: string;
let shoppingItem2Id: string;
let shoppingItemCheckedId: string;
let taskListId: string;
let task1Id: string;
let task2Id: string;
let travelLogId: string;
let travelTripId: string;
let travelActivityId: string;
let lifeLogId: string;
let lifeEventId: string;

async function apiReq(
  path: string,
  opts: { method?: string; token: string; body?: unknown },
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": "application/json",
  };
  const resp = await app.request(path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data };
}

// Track IDs of records created during tests (for cleanup of write-test records)
const cleanupIds: Array<{ collection: string; id: string }> = [];

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );

  // Create test user
  const email = `data-test-${Date.now()}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: "Data Test User",
  });
  userId = user.id;

  // Auth as the user to get a PB token
  const userPb = new PocketBase(PB_URL);
  userPb.autoCancellation(false);
  await userPb.collection("users").authWithPassword(email, password);
  userToken = userPb.authStore.token;

  // --- Recipe data ---
  const box = await adminPb.collection("recipe_boxes").create({
    name: "Test Box",
    description: "A test recipe box",
    visibility: "private",
    owners: [userId],
  });
  recipeBoxId = box.id;

  const r1 = await adminPb.collection("recipes").create({
    box: recipeBoxId,
    data: { name: "Pasta Carbonara", description: "Classic Roman pasta" },
    visibility: "private",
    owners: [userId],
    enrichment_status: "needed",
  });
  recipe1Id = r1.id;

  const r2 = await adminPb.collection("recipes").create({
    box: recipeBoxId,
    data: { name: "Chicken Tikka", description: "Indian grilled chicken" },
    visibility: "private",
    owners: [userId],
    enrichment_status: "done",
  });
  recipe2Id = r2.id;

  // --- Shopping data ---
  const shoppingList = await adminPb.collection("shopping_lists").create({
    name: "Test Grocery List",
    owners: [userId],
  });
  shoppingListId = shoppingList.id;

  const si1 = await adminPb.collection("shopping_items").create({
    list: shoppingListId,
    ingredient: "Milk",
    note: "2%",
    category_id: "dairy",
    checked: false,
    added_by: userId,
  });
  shoppingItem1Id = si1.id;

  const si2 = await adminPb.collection("shopping_items").create({
    list: shoppingListId,
    ingredient: "Bread",
    note: "whole wheat",
    category_id: "bakery",
    checked: false,
    added_by: userId,
  });
  shoppingItem2Id = si2.id;

  const si3 = await adminPb.collection("shopping_items").create({
    list: shoppingListId,
    ingredient: "Eggs",
    note: "",
    category_id: "dairy",
    checked: true,
    added_by: userId,
  });
  shoppingItemCheckedId = si3.id;

  // --- Upkeep data ---
  const taskList = await adminPb.collection("task_lists").create({
    name: "Test Task List",
    owners: [userId],
  });
  taskListId = taskList.id;

  const t1 = await adminPb.collection("tasks").create({
    list: taskListId,
    name: "Clean kitchen",
    description: "Wipe counters and mop",
    frequency: 7,
  });
  task1Id = t1.id;

  const t2 = await adminPb.collection("tasks").create({
    list: taskListId,
    name: "Vacuum living room",
    description: "",
    frequency: 14,
  });
  task2Id = t2.id;

  // --- Travel data ---
  const travelLog = await adminPb.collection("travel_logs").create({
    name: "Test Travel Log",
    owners: [userId],
  });
  travelLogId = travelLog.id;

  const trip = await adminPb.collection("travel_trips").create({
    log: travelLogId,
    destination: "Tokyo",
    status: "Researching",
    region: "Asia",
    notes: "Cherry blossom season",
  });
  travelTripId = trip.id;

  const activity = await adminPb.collection("travel_activities").create({
    log: travelLogId,
    name: "Visit Senso-ji Temple",
    category: "sightseeing",
    location: "Asakusa, Tokyo",
    description: "Famous Buddhist temple",
    trip_id: travelTripId,
  });
  travelActivityId = activity.id;

  // --- Life data ---
  const lifeLog = await adminPb.collection("life_logs").create({
    name: "Test Life Log",
    owners: [userId],
    manifest: { subjects: [] },
    sample_schedule: [],
  });
  lifeLogId = lifeLog.id;

  const event = await adminPb.collection("life_events").create({
    log: lifeLogId,
    subject_id: "mood",
    timestamp: new Date().toISOString(),
    created_by: userId,
    data: { value: 8 },
  });
  lifeEventId = event.id;

  // --- Set user slugs ---
  await adminPb.collection("users").update(userId, {
    shopping_slugs: { groceries: shoppingListId },
    household_slugs: { home: taskListId },
    travel_slugs: { main: travelLogId },
    life_log_id: lifeLogId,
  });
});

afterAll(async () => {
  if (!adminPb) return;

  // Clean up records created by write tests (reverse order)
  for (const { collection, id } of cleanupIds.reverse()) {
    try {
      await adminPb.collection(collection).delete(id);
    } catch { /* already gone */ }
  }

  // Clean up seed data (order matters for cascading relations)
  const seedCleanup: Array<[string, string]> = [
    ["life_events", lifeEventId],
    ["life_logs", lifeLogId],
    ["travel_activities", travelActivityId],
    ["travel_trips", travelTripId],
    ["travel_logs", travelLogId],
    ["tasks", task1Id],
    ["tasks", task2Id],
    ["shopping_items", shoppingItem1Id],
    ["shopping_items", shoppingItem2Id],
    ["shopping_items", shoppingItemCheckedId],
    ["shopping_lists", shoppingListId],
    ["recipes", recipe1Id],
    ["recipes", recipe2Id],
    ["recipe_boxes", recipeBoxId],
    ["users", userId],
  ];

  for (const [collection, id] of seedCleanup) {
    if (!id) continue;
    try {
      await adminPb.collection(collection).delete(id);
    } catch { /* already gone */ }
  }
});

// ==========================================
// Recipes
// ==========================================

describe("Recipes", () => {
  it("GET /data/boxes — returns the test box", async () => {
    const { status, data } = await apiReq("/data/boxes", { token: userToken });
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    const box = data.find((b: any) => b.id === recipeBoxId);
    expect(box).toBeDefined();
    expect(box.name).toBe("Test Box");
    expect(box.description).toBe("A test recipe box");
  });

  it("GET /data/recipes?boxId=X — returns recipes in the box", async () => {
    const { status, data } = await apiReq(`/data/recipes?boxId=${recipeBoxId}`, {
      token: userToken,
    });
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
    const names = data.map((r: any) => r.name);
    expect(names).toContain("Pasta Carbonara");
    expect(names).toContain("Chicken Tikka");
  });

  it("GET /data/recipes/:id — returns a single recipe with data", async () => {
    const { status, data } = await apiReq(`/data/recipes/${recipe1Id}`, {
      token: userToken,
    });
    expect(status).toBe(200);
    expect(data.id).toBe(recipe1Id);
    expect(data.data.name).toBe("Pasta Carbonara");
    expect(data.data.description).toBe("Classic Roman pasta");
    expect(data.visibility).toBe("private");
    expect(data.enrichment_status).toBe("needed");
  });

  it("POST /data/boxes — creates a new box", async () => {
    const { status, data } = await apiReq("/data/boxes", {
      method: "POST",
      token: userToken,
      body: { name: "New Box", description: "Created in test" },
    });
    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.name).toBe("New Box");
    cleanupIds.push({ collection: "recipe_boxes", id: data.id });
  });

  it("POST /data/recipes — creates a recipe in a box", async () => {
    const { status, data } = await apiReq("/data/recipes", {
      method: "POST",
      token: userToken,
      body: {
        boxId: recipeBoxId,
        data: { name: "New Recipe", description: "Test recipe" },
      },
    });
    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.name).toBe("New Recipe");
    cleanupIds.push({ collection: "recipes", id: data.id });
  });

  it("recipe surgical ops — patch_recipe, ingredients, steps round-trip", async () => {
    // Fresh recipe so we don't disturb the seeded ones.
    const create = await apiReq("/data/recipes", {
      method: "POST",
      token: userToken,
      body: {
        boxId: recipeBoxId,
        data: {
          name: "Surgical-ops Test",
          recipeIngredient: ["1 cup flour", "1 tsp salt"],
          recipeInstructions: [
            { "@type": "HowToStep", text: "Mix dry" },
            { "@type": "HowToStep", text: "Bake" },
          ],
        },
      },
    });
    expect(create.status).toBe(201);
    const recipeId = create.data.id as string;
    cleanupIds.push({ collection: "recipes", id: recipeId });

    // patch_recipe — partial top-level merge + null clears
    const patched = await apiReq(`/data/recipes/${recipeId}/data`, {
      method: "PATCH",
      token: userToken,
      body: { fields: { recipeYield: "4 servings", recipeCuisine: "Italian", description: null } },
    });
    expect(patched.status).toBe(200);
    const get1 = await apiReq(`/data/recipes/${recipeId}`, { token: userToken });
    expect(get1.data.data.recipeYield).toBe("4 servings");
    expect(get1.data.data.recipeCuisine).toBe("Italian");
    expect(get1.data.data.description).toBeUndefined();
    expect(get1.data.enrichment_status).toBe("needed");

    // add_recipe_ingredient — append + insert at position
    const add1 = await apiReq(`/data/recipes/${recipeId}/ingredients`, {
      method: "POST",
      token: userToken,
      body: { ingredient: "2 eggs" },
    });
    expect(add1.status).toBe(200);
    expect(add1.data.count).toBe(3);
    const add2 = await apiReq(`/data/recipes/${recipeId}/ingredients`, {
      method: "POST",
      token: userToken,
      body: { ingredient: "1 tbsp butter", position: 0 },
    });
    expect(add2.status).toBe(200);
    expect(add2.data.position).toBe(0);
    expect(add2.data.items[0]).toBe("1 tbsp butter");

    // update_recipe_ingredient
    const upd = await apiReq(`/data/recipes/${recipeId}/ingredients/2`, {
      method: "PATCH",
      token: userToken,
      body: { ingredient: "1 tsp kosher salt" },
    });
    expect(upd.status).toBe(200);
    expect(upd.data.items[2]).toBe("1 tsp kosher salt");

    // reorder_recipe_ingredients — reverse the array
    const len = upd.data.count as number;
    const reverse = Array.from({ length: len }, (_, i) => len - 1 - i);
    const reord = await apiReq(`/data/recipes/${recipeId}/ingredients/reorder`, {
      method: "POST",
      token: userToken,
      body: { order: reverse },
    });
    expect(reord.status).toBe(200);

    // Bad permutation rejected
    const badReord = await apiReq(`/data/recipes/${recipeId}/ingredients/reorder`, {
      method: "POST",
      token: userToken,
      body: { order: [0, 0, 1, 2] },
    });
    expect(badReord.status).toBe(400);

    // remove_recipe_ingredient
    const rm = await apiReq(`/data/recipes/${recipeId}/ingredients/0`, {
      method: "DELETE",
      token: userToken,
    });
    expect(rm.status).toBe(200);
    expect(rm.data.count).toBe(len - 1);

    // Steps surgical ops
    const stepAdd = await apiReq(`/data/recipes/${recipeId}/steps`, {
      method: "POST",
      token: userToken,
      body: { text: "Rest 30 min", ingredients: ["dough"], position: 1 },
    });
    expect(stepAdd.status).toBe(200);
    expect(stepAdd.data.items[1].text).toBe("Rest 30 min");
    expect(stepAdd.data.items[1].ingredients).toEqual(["dough"]);

    const stepPatch = await apiReq(`/data/recipes/${recipeId}/steps/1`, {
      method: "PATCH",
      token: userToken,
      body: { ingredients: null },
    });
    expect(stepPatch.status).toBe(200);
    expect(stepPatch.data.items[1].ingredients).toBeUndefined();

    const stepRm = await apiReq(`/data/recipes/${recipeId}/steps/0`, {
      method: "DELETE",
      token: userToken,
    });
    expect(stepRm.status).toBe(200);

    // Out-of-range index returns 400
    const oob = await apiReq(`/data/recipes/${recipeId}/steps/99`, {
      method: "DELETE",
      token: userToken,
    });
    expect(oob.status).toBe(400);
  });

  it("PATCH /data/cooking-log/:eventId — edits notes and timestamp independently", async () => {
    // Create a cooking log entry to edit
    const created = await apiReq(`/data/recipes/${recipe1Id}/cooking-log`, {
      method: "POST",
      token: userToken,
      body: { notes: "Original notes" },
    });
    expect(created.status).toBe(201);
    const eventId = created.data.id as string;

    // Patch only the timestamp
    const ts = "2024-12-25T10:00:00Z";
    const patchTs = await apiReq(`/data/cooking-log/${eventId}`, {
      method: "PATCH",
      token: userToken,
      body: { timestamp: ts },
    });
    expect(patchTs.status).toBe(200);
    expect(patchTs.data.timestamp).toContain("2024-12-25");
    expect(patchTs.data.notes).toBe("Original notes");

    // Patch only notes (clear them)
    const patchNotes = await apiReq(`/data/cooking-log/${eventId}`, {
      method: "PATCH",
      token: userToken,
      body: { notes: "" },
    });
    expect(patchNotes.status).toBe(200);
    expect(patchNotes.data.notes).toBeUndefined();

    // Empty body returns 400
    const empty = await apiReq(`/data/cooking-log/${eventId}`, {
      method: "PATCH",
      token: userToken,
      body: {},
    });
    expect(empty.status).toBe(400);

    // Cleanup
    await apiReq(`/data/cooking-log/${eventId}`, {
      method: "DELETE",
      token: userToken,
    });
  });
});

// ==========================================
// Shopping
// ==========================================

describe("Shopping", () => {
  it("GET /data/shopping/lists — returns the test list", async () => {
    const { status, data } = await apiReq("/data/shopping/lists", {
      token: userToken,
    });
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    const list = data.find((l: any) => l.id === shoppingListId);
    expect(list).toBeDefined();
    expect(list.slug).toBe("groceries");
    expect(list.name).toBe("Test Grocery List");
  });

  it("GET /data/shopping/items?list=X — returns items", async () => {
    const { status, data } = await apiReq(
      `/data/shopping/items?list=${shoppingListId}`,
      { token: userToken },
    );
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(3);
    const milk = data.find((i: any) => i.ingredient === "Milk");
    expect(milk).toBeDefined();
    expect(milk.note).toBe("2%");
    expect(milk.category_id).toBe("dairy");
  });

  it("POST /data/shopping/items — adds an item", async () => {
    const { status, data } = await apiReq("/data/shopping/items", {
      method: "POST",
      token: userToken,
      body: {
        list: shoppingListId,
        ingredient: "Butter",
        note: "unsalted",
        category_id: "dairy",
      },
    });
    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.ingredient).toBe("Butter");
    cleanupIds.push({ collection: "shopping_items", id: data.id });
  });

  it("PATCH /data/shopping/items/:id — toggles checked", async () => {
    const { status, data } = await apiReq(
      `/data/shopping/items/${shoppingItem1Id}`,
      {
        method: "PATCH",
        token: userToken,
        body: { checked: true },
      },
    );
    expect(status).toBe(200);
    expect(data.id).toBe(shoppingItem1Id);
    expect(data.checked).toBe(true);

    // Reset it back
    await apiReq(`/data/shopping/items/${shoppingItem1Id}`, {
      method: "PATCH",
      token: userToken,
      body: { checked: false },
    });
  });

  it("DELETE /data/shopping/items/:id — deletes an item", async () => {
    // Create a throwaway item to delete
    const create = await apiReq("/data/shopping/items", {
      method: "POST",
      token: userToken,
      body: { list: shoppingListId, ingredient: "ToDelete" },
    });
    expect(create.status).toBe(201);

    const { status, data } = await apiReq(
      `/data/shopping/items/${create.data.id}`,
      { method: "DELETE", token: userToken },
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  it("POST /data/shopping/clear-checked — clears checked items", async () => {
    // Create a checked item to clear
    const item = await adminPb.collection("shopping_items").create({
      list: shoppingListId,
      ingredient: "ClearMe",
      checked: true,
      added_by: userId,
    });

    const { status, data } = await apiReq("/data/shopping/clear-checked", {
      method: "POST",
      token: userToken,
      body: { list: shoppingListId },
    });
    expect(status).toBe(200);
    expect(data.deleted).toBeGreaterThanOrEqual(1);

    // The pre-existing checked "Eggs" item should also be gone
    // Recreate it for other tests that don't depend on it
  });
});

// ==========================================
// Upkeep
// ==========================================

describe("Upkeep", () => {
  it("GET /data/tasks?list=X — returns tasks", async () => {
    const { status, data } = await apiReq(
      `/data/tasks?list=${taskListId}`,
      { token: userToken },
    );
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(2);
    const kitchen = data.find((t: any) => t.name === "Clean kitchen");
    expect(kitchen).toBeDefined();
    expect(kitchen.description).toBe("Wipe counters and mop");
  });

  it("POST /data/tasks — creates a task", async () => {
    const { status, data } = await apiReq("/data/tasks", {
      method: "POST",
      token: userToken,
      body: {
        list: taskListId,
        name: "Dust shelves",
        description: "All bookshelves",
        frequency: 30,
      },
    });
    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.name).toBe("Dust shelves");
    cleanupIds.push({ collection: "tasks", id: data.id });
  });

  it("POST /data/tasks/:id/complete — completes a task", async () => {
    const { status, data } = await apiReq(
      `/data/tasks/${task1Id}/complete`,
      { method: "POST", token: userToken },
    );
    expect(status).toBe(200);
    expect(data.id).toBe(task1Id);
    expect(data.last_completed).toBeDefined();
    expect(new Date(data.last_completed).getTime()).toBeGreaterThan(
      Date.now() - 10000,
    );
  });

  it("POST /data/tasks/:id/snooze — snoozes a task", async () => {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { status, data } = await apiReq(
      `/data/tasks/${task2Id}/snooze`,
      {
        method: "POST",
        token: userToken,
        body: { until },
      },
    );
    expect(status).toBe(200);
    expect(data.id).toBe(task2Id);
    expect(data.snoozed_until).toBeDefined();
  });

  it("POST /data/tasks/:id/move — reparents and recomputes descendant paths", async () => {
    // Build: parent A → child B → grandchild C, plus uncle D (root, sibling of A).
    const a = await apiReq("/data/tasks", {
      method: "POST",
      token: userToken,
      body: { list: taskListId, name: "A" },
    });
    cleanupIds.push({ collection: "tasks", id: a.data.id });
    const b = await apiReq("/data/tasks", {
      method: "POST",
      token: userToken,
      body: { list: taskListId, name: "B", parent_id: a.data.id },
    });
    cleanupIds.push({ collection: "tasks", id: b.data.id });
    const cTask = await apiReq("/data/tasks", {
      method: "POST",
      token: userToken,
      body: { list: taskListId, name: "C", parent_id: b.data.id },
    });
    cleanupIds.push({ collection: "tasks", id: cTask.data.id });
    const d = await apiReq("/data/tasks", {
      method: "POST",
      token: userToken,
      body: { list: taskListId, name: "D" },
    });
    cleanupIds.push({ collection: "tasks", id: d.data.id });

    // Move B (and its subtree containing C) under D.
    const moved = await apiReq(`/data/tasks/${b.data.id}/move`, {
      method: "POST",
      token: userToken,
      body: { new_parent_id: d.data.id },
    });
    expect(moved.status).toBe(200);
    expect(moved.data.parent_id).toBe(d.data.id);
    expect(moved.data.path).toBe(`${d.data.id}/${b.data.id}`);
    expect(moved.data.descendants_updated).toBe(1);

    // Confirm C's path was rewritten to live under the new B path.
    const tasks = await apiReq(`/data/tasks?list=${taskListId}`, { token: userToken });
    const c = tasks.data.find((t: any) => t.id === cTask.data.id);
    expect(c.path).toBe(`${d.data.id}/${b.data.id}/${cTask.data.id}`);

    // Cycle prevention: moving D under C should fail.
    const cycle = await apiReq(`/data/tasks/${d.data.id}/move`, {
      method: "POST",
      token: userToken,
      body: { new_parent_id: cTask.data.id },
    });
    expect(cycle.status).toBe(400);
  });
});

// ==========================================
// Travel
// ==========================================

describe("Travel", () => {
  it("GET /data/travel/logs — returns travel logs", async () => {
    const { status, data } = await apiReq("/data/travel/logs", {
      token: userToken,
    });
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    const log = data.find((l: any) => l.id === travelLogId);
    expect(log).toBeDefined();
    expect(log.slug).toBe("main");
    expect(log.name).toBe("Test Travel Log");
  });

  it("GET /data/travel/trips?log=X — returns trips", async () => {
    const { status, data } = await apiReq(
      `/data/travel/trips?log=${travelLogId}`,
      { token: userToken },
    );
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    const trip = data.find((t: any) => t.id === travelTripId);
    expect(trip).toBeDefined();
    expect(trip.destination).toBe("Tokyo");
    expect(trip.status).toBe("Researching");
    expect(trip.region).toBe("Asia");
  });

  it("GET /data/travel/activities?log=X — returns activities", async () => {
    const { status, data } = await apiReq(
      `/data/travel/activities?log=${travelLogId}`,
      { token: userToken },
    );
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    const act = data.find((a: any) => a.id === travelActivityId);
    expect(act).toBeDefined();
    expect(act.name).toBe("Visit Senso-ji Temple");
    expect(act.category).toBe("sightseeing");
  });

  it("GET /data/travel/itineraries?log=X — returns itineraries", async () => {
    const { status, data } = await apiReq(
      `/data/travel/itineraries?log=${travelLogId}`,
      { token: userToken },
    );
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    // No itineraries created in seed data, so just check the shape
  });

  it("POST /data/travel/trips — creates a trip", async () => {
    const { status, data } = await apiReq("/data/travel/trips", {
      method: "POST",
      token: userToken,
      body: {
        log: travelLogId,
        destination: "Kyoto",
        status: "Idea",
        region: "Asia",
        notes: "Temples and gardens",
      },
    });
    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.destination).toBe("Kyoto");
    cleanupIds.push({ collection: "travel_trips", id: data.id });
  });

  it("PATCH /data/travel/trips/:id — updates a trip", async () => {
    const { status, data } = await apiReq(
      `/data/travel/trips/${travelTripId}`,
      {
        method: "PATCH",
        token: userToken,
        body: { notes: "Updated notes", status: "Booked" },
      },
    );
    expect(status).toBe(200);
    expect(data.id).toBe(travelTripId);
    expect(data.notes).toBe("Updated notes");
    expect(data.status).toBe("Booked");
  });

  it("POST /data/travel/activities — creates an activity", async () => {
    const { status, data } = await apiReq("/data/travel/activities", {
      method: "POST",
      token: userToken,
      body: {
        log: travelLogId,
        trip_id: travelTripId,
        name: "Tsukiji Fish Market",
        category: "food",
        location: "Tsukiji, Tokyo",
      },
    });
    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.name).toBe("Tsukiji Fish Market");
    cleanupIds.push({ collection: "travel_activities", id: data.id });
  });

  it("PATCH /data/travel/activities/:id — updates an activity", async () => {
    const { status, data } = await apiReq(
      `/data/travel/activities/${travelActivityId}`,
      {
        method: "PATCH",
        token: userToken,
        body: { description: "Updated description", rating: 5 },
      },
    );
    expect(status).toBe(200);
    expect(data.id).toBe(travelActivityId);
    expect(data.description).toBe("Updated description");
  });

  it("POST /data/travel/itineraries — creates an itinerary", async () => {
    const { status, data } = await apiReq("/data/travel/itineraries", {
      method: "POST",
      token: userToken,
      body: {
        log: travelLogId,
        trip_id: travelTripId,
        name: "3-Day Tokyo Plan",
        is_active: true,
        days: [{ day: 1, activities: [] }],
      },
    });
    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.name).toBe("3-Day Tokyo Plan");
    cleanupIds.push({ collection: "travel_itineraries", id: data.id });
  });

  it("itinerary surgical ops — add/update/move/remove a slot round-trip", async () => {
    // Fresh itinerary with two empty days, so we can test cross-day moves too.
    const create = await apiReq("/data/travel/itineraries", {
      method: "POST",
      token: userToken,
      body: {
        log: travelLogId,
        trip_id: travelTripId,
        name: "Surgical-ops test",
        days: [
          { label: "Day 1", slots: [] },
          { label: "Day 2", slots: [] },
        ],
      },
    });
    expect(create.status).toBe(201);
    const itinId = create.data.id as string;
    cleanupIds.push({ collection: "travel_itineraries", id: itinId });

    // Add slot to day 0
    const added = await apiReq(`/data/travel/itineraries/${itinId}/days/0/slots`, {
      method: "POST",
      token: userToken,
      body: { activity_id: travelActivityId, start_time: "9:00 AM" },
    });
    expect(added.status).toBe(200);
    expect(added.data.day_index).toBe(0);
    expect(added.data.day.slots).toHaveLength(1);
    expect(added.data.day.slots[0].activityId).toBe(travelActivityId);
    expect(added.data.day.slots[0].startTime).toBe("9:00 AM");

    // Patch the slot's notes; clear startTime via null
    const patched = await apiReq(`/data/travel/itineraries/${itinId}/days/0/slots/0`, {
      method: "PATCH",
      token: userToken,
      body: { notes: "Arrive early", start_time: null },
    });
    expect(patched.status).toBe(200);
    expect(patched.data.day.slots[0].notes).toBe("Arrive early");
    expect(patched.data.day.slots[0].startTime).toBeUndefined();

    // Move the slot from day 0 to day 1
    const moved = await apiReq(`/data/travel/itineraries/${itinId}/days/0/slots/0/move`, {
      method: "POST",
      token: userToken,
      body: { to_day_index: 1 },
    });
    expect(moved.status).toBe(200);
    expect(moved.data.from_day.slots).toHaveLength(0);
    expect(moved.data.to_day.slots).toHaveLength(1);
    expect(moved.data.to_day.slots[0].activityId).toBe(travelActivityId);

    // Patch day 1's label
    const dayPatch = await apiReq(`/data/travel/itineraries/${itinId}/days/1`, {
      method: "PATCH",
      token: userToken,
      body: { label: "Day 2 — Senso-ji" },
    });
    expect(dayPatch.status).toBe(200);
    expect(dayPatch.data.day.label).toBe("Day 2 — Senso-ji");

    // Remove the slot
    const removed = await apiReq(`/data/travel/itineraries/${itinId}/days/1/slots/0`, {
      method: "DELETE",
      token: userToken,
    });
    expect(removed.status).toBe(200);
    expect(removed.data.day.slots).toHaveLength(0);

    // Out-of-range day_index returns 400
    const bad = await apiReq(`/data/travel/itineraries/${itinId}/days/99/slots`, {
      method: "POST",
      token: userToken,
      body: { activity_id: travelActivityId },
    });
    expect(bad.status).toBe(400);

    // Missing itinerary surfaces as 404 (not 500) — confirms the handler
    // wrapper forwards PB's upstream 4xx instead of collapsing to 500.
    const missing = await apiReq("/data/travel/itineraries/nonexistent_id/days/0", {
      method: "PATCH",
      token: userToken,
      body: { label: "x" },
    });
    expect(missing.status).toBe(404);
  });
});

// ==========================================
// Life
// ==========================================

describe("Life", () => {
  it("GET /data/life/log — returns the user's life log", async () => {
    const { status, data } = await apiReq("/data/life/log", {
      token: userToken,
    });
    expect(status).toBe(200);
    expect(data.id).toBe(lifeLogId);
    expect(data.name).toBe("Test Life Log");
    expect(data.manifest).toBeDefined();
  });

  it("GET /data/life/entries?log=X — returns entries", async () => {
    const { status, data } = await apiReq(
      `/data/life/entries?log=${lifeLogId}`,
      { token: userToken },
    );
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    const entry = data.find((e: any) => e.id === lifeEventId);
    expect(entry).toBeDefined();
    expect(entry.subject_id).toBe("mood");
    expect(entry.data.value).toBe(8);
  });
});
