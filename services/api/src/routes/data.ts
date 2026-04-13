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

  const trips = await pb.collection("travel_trips").getFullList({ filter: pb.filter("log = {:logId}", { logId }) });
  return c.json(trips.map((t) => ({
    id: t.id,
    log: t.log,
    destination: t.destination,
    status: t.status,
    region: t.region,
    start_date: t.start_date,
    end_date: t.end_date,
    notes: t.notes,
  })));
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
