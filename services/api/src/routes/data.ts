/**
 * Read endpoints for MCP/curl access to app data.
 * The frontend doesn't use these — it talks to PocketBase directly.
 */
import { Hono } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";

export const dataRoutes = new Hono<AppEnv>();

// List recipe boxes for the authenticated user
dataRoutes.get("/boxes", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const boxes = await pb.collection("recipe_boxes").getFullList({
    filter: pb.filter("owners.id ?= {:userId}", { userId }),
  });
  return c.json(boxes.map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    visibility: b.visibility,
    owners: b.owners,
  })));
}));

// List recipes in a box
dataRoutes.get("/recipes", handler(async (c) => {
  const pb = c.get("pb");
  const boxId = c.req.query("boxId");
  if (!boxId) return c.json({ error: "boxId query param required" }, 400);

  const recipes = await pb.collection("recipes").getFullList({ filter: pb.filter("box = {:boxId}", { boxId }) });
  return c.json(recipes.map((r) => ({
    id: r.id,
    box: r.box,
    name: (r.data as Record<string, unknown>)?.name,
    description: (r.data as Record<string, unknown>)?.description,
    visibility: r.visibility,
    enrichment_status: r.enrichment_status,
  })));
}));

// Get a single recipe with full data
dataRoutes.get("/recipes/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const r = await pb.collection("recipes").getOne(id);
  return c.json({
    id: r.id,
    box: r.box,
    data: r.data,
    visibility: r.visibility,
    enrichment_status: r.enrichment_status,
    pending_changes: r.pending_changes,
    step_ingredients: r.step_ingredients,
  });
}));

// List shopping lists for the authenticated user
dataRoutes.get("/shopping/lists", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const user = await pb.collection("users").getOne(userId);
  const slugs = (user.shopping_slugs || {}) as Record<string, string>;
  const lists = await Promise.all(
    Object.entries(slugs).map(async ([slug, listId]) => {
      try {
        const list = await pb.collection("shopping_lists").getOne(listId);
        return { id: listId, slug, name: list.name };
      } catch {
        return { id: listId, slug, name: "(not found)" };
      }
    })
  );
  return c.json(lists);
}));

// List items in a shopping list
dataRoutes.get("/shopping/items", handler(async (c) => {
  const pb = c.get("pb");
  const listId = c.req.query("list");
  if (!listId) return c.json({ error: "list query param required" }, 400);

  const items = await pb.collection("shopping_items").getFullList({ filter: pb.filter("list = {:listId}", { listId }) });
  return c.json(items.map((i) => ({
    id: i.id,
    ingredient: i.ingredient,
    note: i.note,
    category_id: i.category_id,
    checked: i.checked,
  })));
}));

// Add an item to a shopping list
dataRoutes.post("/shopping/items", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const { list, ingredient, note, category_id } = await c.req.json<{
    list: string;
    ingredient: string;
    note?: string;
    category_id?: string;
  }>();

  if (!list || !ingredient) {
    return c.json({ error: "list and ingredient required" }, 400);
  }

  const record = await pb.collection("shopping_items").create({
    list,
    ingredient,
    note: note || "",
    category_id: category_id || "uncategorized",
    checked: false,
    added_by: userId,
  });
  return c.json({ id: record.id, ingredient: record.ingredient }, 201);
}));

// Delete a shopping item
dataRoutes.delete("/shopping/items/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  await pb.collection("shopping_items").delete(id);
  return c.json({ success: true });
}));

// Toggle checked status on a shopping item
dataRoutes.patch("/shopping/items/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const body = await c.req.json<{ checked?: boolean }>();
  const record = await pb.collection("shopping_items").update(id, body);
  return c.json({ id: record.id, checked: record.checked });
}));

// Clear all checked items from a shopping list
dataRoutes.post("/shopping/clear-checked", handler(async (c) => {
  const pb = c.get("pb");
  const { list } = await c.req.json<{ list: string }>();
  if (!list) return c.json({ error: "list required" }, 400);

  const items = await pb.collection("shopping_items").getFullList({
    filter: pb.filter("list = {:list} && checked = true", { list }),
  });
  await Promise.all(items.map((i) => pb.collection("shopping_items").delete(i.id)));
  return c.json({ deleted: items.length });
}));

// ---- Recipe write ----

// Create a recipe box
dataRoutes.post("/boxes", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const { name, description } = await c.req.json<{ name: string; description?: string }>();
  if (!name) return c.json({ error: "name required" }, 400);

  const record = await pb.collection("recipe_boxes").create({
    name,
    description: description || "",
    visibility: "private",
    owners: [userId],
  });
  return c.json({ id: record.id, name: record.name }, 201);
}));

// Create a recipe in a box
dataRoutes.post("/recipes", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const { boxId, data } = await c.req.json<{ boxId: string; data: Record<string, unknown> }>();
  if (!boxId || !data) return c.json({ error: "boxId and data required" }, 400);

  const record = await pb.collection("recipes").create({
    box: boxId,
    data,
    owners: [userId],
    visibility: "private",
    enrichment_status: "needed",
  });
  return c.json({ id: record.id, name: (record.data as Record<string, unknown>)?.name }, 201);
}));

// ---- Travel ----

// List travel logs for the authenticated user
dataRoutes.get("/travel/logs", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const user = await pb.collection("users").getOne(userId);
  const slugs = (user.travel_slugs || {}) as Record<string, string>;
  const logs = await Promise.all(
    Object.entries(slugs).map(async ([slug, logId]) => {
      try {
        const log = await pb.collection("travel_logs").getOne(logId);
        return { id: logId, slug, name: log.name };
      } catch {
        return { id: logId, slug, name: "(not found)" };
      }
    })
  );
  return c.json(logs);
}));

// List trips in a travel log
dataRoutes.get("/travel/trips", handler(async (c) => {
  const pb = c.get("pb");
  const logId = c.req.query("log");
  if (!logId) return c.json({ error: "log query param required" }, 400);
  const status = c.req.query("status"); // optional filter by status

  let filter = pb.filter("log = {:logId}", { logId });
  if (status) filter += ` && status = "${status}"`;

  const trips = await pb.collection("travel_trips").getFullList({ filter });
  return c.json(trips.map((t) => ({
    id: t.id,
    log: t.log,
    destination: t.destination,
    status: t.status,
    region: t.region,
    start_date: t.start_date,
    end_date: t.end_date,
    // Summary only — use GET /travel/trips/:id for full notes
    notes_preview: t.notes ? t.notes.slice(0, 100) + (t.notes.length > 100 ? "..." : "") : "",
  })));
}));

// Get a single trip with full details
dataRoutes.get("/travel/trips/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const t = await pb.collection("travel_trips").getOne(id);
  return c.json({
    id: t.id,
    log: t.log,
    destination: t.destination,
    status: t.status,
    region: t.region,
    start_date: t.start_date,
    end_date: t.end_date,
    notes: t.notes,
    flagged_for_review: t.flagged_for_review,
    review_comment: t.review_comment,
    checklist_done: t.checklist_done,
  });
}));

// List activities in a travel log
dataRoutes.get("/travel/activities", handler(async (c) => {
  const pb = c.get("pb");
  const logId = c.req.query("log");
  if (!logId) return c.json({ error: "log query param required" }, 400);

  const activities = await pb.collection("travel_activities").getFullList({ filter: pb.filter("log = {:logId}", { logId }) });
  return c.json(activities.map((a) => ({
    id: a.id,
    log: a.log,
    name: a.name,
    category: a.category,
    location: a.location,
    description: a.description,
    cost_notes: a.cost_notes,
    duration_estimate: a.duration_estimate,
    setting: a.setting,
    rating: a.rating,
    trip_id: a.trip_id,
  })));
}));

// List itineraries in a travel log
dataRoutes.get("/travel/itineraries", handler(async (c) => {
  const pb = c.get("pb");
  const logId = c.req.query("log");
  if (!logId) return c.json({ error: "log query param required" }, 400);

  const itineraries = await pb.collection("travel_itineraries").getFullList({ filter: pb.filter("log = {:logId}", { logId }) });
  return c.json(itineraries.map((i) => ({
    id: i.id,
    log: i.log,
    trip_id: i.trip_id,
    name: i.name,
    is_active: i.is_active,
    days: i.days,
  })));
}));

// Create a travel trip
dataRoutes.post("/travel/trips", handler(async (c) => {
  const pb = c.get("pb");
  const body = await c.req.json<{
    log: string;
    destination: string;
    status?: string;
    region?: string;
    start_date?: string;
    end_date?: string;
    notes?: string;
  }>();
  if (!body.log || !body.destination) return c.json({ error: "log and destination required" }, 400);

  const record = await pb.collection("travel_trips").create({
    log: body.log,
    destination: body.destination,
    status: body.status || "planning",
    region: body.region || "",
    start_date: body.start_date || "",
    end_date: body.end_date || "",
    notes: body.notes || "",
  });
  return c.json({ id: record.id, destination: record.destination }, 201);
}));

// Update a travel trip
dataRoutes.patch("/travel/trips/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const body = await c.req.json<Record<string, unknown>>();
  const record = await pb.collection("travel_trips").update(id, body);
  return c.json({
    id: record.id,
    destination: record.destination,
    status: record.status,
    region: record.region,
    start_date: record.start_date,
    end_date: record.end_date,
    notes: record.notes,
  });
}));

// Create a travel activity
dataRoutes.post("/travel/activities", handler(async (c) => {
  const pb = c.get("pb");
  const body = await c.req.json<{
    log: string;
    trip_id: string;
    name: string;
    category?: string;
    location?: string;
    description?: string;
    cost_notes?: string;
    duration_estimate?: string;
    setting?: string;
  }>();
  if (!body.log || !body.name) return c.json({ error: "log and name required" }, 400);

  const record = await pb.collection("travel_activities").create({
    log: body.log,
    trip_id: body.trip_id || "",
    name: body.name,
    category: body.category || "",
    location: body.location || "",
    description: body.description || "",
    cost_notes: body.cost_notes || "",
    duration_estimate: body.duration_estimate || "",
    setting: body.setting || "",
  });
  return c.json({ id: record.id, name: record.name }, 201);
}));

// Update a travel activity
dataRoutes.patch("/travel/activities/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const body = await c.req.json<Record<string, unknown>>();
  const record = await pb.collection("travel_activities").update(id, body);
  return c.json({
    id: record.id,
    name: record.name,
    category: record.category,
    location: record.location,
    description: record.description,
    trip_id: record.trip_id,
  });
}));

// Create a travel itinerary
dataRoutes.post("/travel/itineraries", handler(async (c) => {
  const pb = c.get("pb");
  const body = await c.req.json<{
    log: string;
    trip_id: string;
    name: string;
    is_active?: boolean;
    days?: unknown;
  }>();
  if (!body.log || !body.trip_id || !body.name) return c.json({ error: "log, trip_id, and name required" }, 400);

  const record = await pb.collection("travel_itineraries").create({
    log: body.log,
    trip_id: body.trip_id,
    name: body.name,
    is_active: body.is_active ?? false,
    days: body.days || [],
  });
  return c.json({ id: record.id, name: record.name }, 201);
}));

// ---- Life ----

// Get the user's life log
dataRoutes.get("/life/log", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const user = await pb.collection("users").getOne(userId);
  const logId = user.life_log_id as string;
  if (!logId) return c.json({ error: "no life log configured" }, 404);

  const log = await pb.collection("life_logs").getOne(logId);
  return c.json({
    id: log.id,
    name: log.name,
    manifest: log.manifest,
    sample_schedule: log.sample_schedule,
  });
}));

// List entries (events) in a life log
dataRoutes.get("/life/entries", handler(async (c) => {
  const pb = c.get("pb");
  const logId = c.req.query("log");
  if (!logId) return c.json({ error: "log query param required" }, 400);

  const entries = await pb.collection("life_events").getFullList({
    filter: pb.filter("log = {:logId}", { logId }),
    sort: "-timestamp",
  });
  return c.json(entries.map((e) => ({
    id: e.id,
    log: e.log,
    subject_id: e.subject_id,
    timestamp: e.timestamp,
    data: e.data,
    created_by: e.created_by,
  })));
}));

// ---- Upkeep ----

// List upkeep tasks
dataRoutes.get("/tasks", handler(async (c) => {
  const pb = c.get("pb");
  const listId = c.req.query("list");
  if (!listId) return c.json({ error: "list query param required" }, 400);

  const tasks = await pb.collection("tasks").getFullList({ filter: pb.filter("list = {:listId}", { listId }) });
  return c.json(tasks.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    room_id: t.room_id,
    frequency: t.frequency,
    last_completed: t.last_completed,
    snoozed_until: t.snoozed_until,
  })));
}));

// Create a task
dataRoutes.post("/tasks", handler(async (c) => {
  const pb = c.get("pb");
  const body = await c.req.json<{
    list: string;
    name: string;
    description?: string;
    room_id?: string;
    frequency?: number;
  }>();
  if (!body.list || !body.name) return c.json({ error: "list and name required" }, 400);

  const record = await pb.collection("tasks").create({
    list: body.list,
    name: body.name,
    description: body.description || "",
    room_id: body.room_id || "",
    frequency: body.frequency || 0,
  });
  return c.json({ id: record.id, name: record.name }, 201);
}));

// Complete a task
dataRoutes.post("/tasks/:id/complete", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const now = new Date().toISOString();
  const record = await pb.collection("tasks").update(id, {
    last_completed: now,
    snoozed_until: "",
  });
  return c.json({ id: record.id, last_completed: record.last_completed });
}));

// Snooze a task
dataRoutes.post("/tasks/:id/snooze", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const { until } = await c.req.json<{ until: string }>();
  if (!until) return c.json({ error: "until (ISO date) required" }, 400);

  const record = await pb.collection("tasks").update(id, { snoozed_until: until });
  return c.json({ id: record.id, snoozed_until: record.snoozed_until });
}));
