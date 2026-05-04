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

// Update a shopping item — checked toggle, note, or category
dataRoutes.patch("/shopping/items/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const body = await c.req.json<{
    checked?: boolean;
    note?: string;
    category_id?: string;
    ingredient?: string;
  }>();
  const updates: Record<string, unknown> = {};
  if (body.checked !== undefined) updates.checked = body.checked;
  if (body.note !== undefined) updates.note = body.note;
  if (body.category_id !== undefined) updates.category_id = body.category_id;
  if (body.ingredient !== undefined) updates.ingredient = body.ingredient;
  if (Object.keys(updates).length === 0) return c.json({ error: "no fields provided" }, 400);

  const record = await pb.collection("shopping_items").update(id, updates);
  return c.json({
    id: record.id,
    ingredient: record.ingredient,
    note: record.note,
    category_id: record.category_id,
    checked: record.checked,
  });
}));

// Create a shopping list. Stores its slug in the user's shopping_slugs map
// so it shows up in their list inventory.
dataRoutes.post("/shopping/lists", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const { name, slug } = await c.req.json<{ name: string; slug?: string }>();
  if (!name) return c.json({ error: "name required" }, 400);
  const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "list";

  const record = await pb.collection("shopping_lists").create({
    name,
    owners: [userId],
  });

  const user = await pb.collection("users").getOne(userId);
  const slugs = { ...((user.shopping_slugs || {}) as Record<string, string>), [finalSlug]: record.id };
  await pb.collection("users").update(userId, { shopping_slugs: slugs });

  return c.json({ id: record.id, name: record.name, slug: finalSlug }, 201);
}));

// Update a shopping list — rename or change its slug in the user's map
dataRoutes.patch("/shopping/lists/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const body = await c.req.json<{ name?: string; slug?: string }>();

  if (body.name !== undefined) {
    await pb.collection("shopping_lists").update(id, { name: body.name });
  }

  if (body.slug !== undefined) {
    const user = await pb.collection("users").getOne(userId);
    const slugs = { ...((user.shopping_slugs || {}) as Record<string, string>) };
    for (const [s, listId] of Object.entries(slugs)) {
      if (listId === id) delete slugs[s];
    }
    slugs[body.slug] = id;
    await pb.collection("users").update(userId, { shopping_slugs: slugs });
  }

  const record = await pb.collection("shopping_lists").getOne(id);
  return c.json({ id: record.id, name: record.name });
}));

// Delete a shopping list (and remove from user's slug map)
dataRoutes.delete("/shopping/lists/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  await pb.collection("shopping_lists").delete(id);
  try {
    const user = await pb.collection("users").getOne(userId);
    const slugs = { ...((user.shopping_slugs || {}) as Record<string, string>) };
    let changed = false;
    for (const [s, listId] of Object.entries(slugs)) {
      if (listId === id) { delete slugs[s]; changed = true; }
    }
    if (changed) await pb.collection("users").update(userId, { shopping_slugs: slugs });
  } catch {}
  return c.json({ success: true });
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

// Update a recipe box (name, description, visibility)
dataRoutes.patch("/boxes/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const body = await c.req.json<{
    name?: string;
    description?: string;
    visibility?: "private" | "public" | "unlisted";
  }>();
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.visibility !== undefined) updates.visibility = body.visibility;
  if (Object.keys(updates).length === 0) return c.json({ error: "no fields provided" }, 400);

  const record = await pb.collection("recipe_boxes").update(id, updates);
  return c.json({ id: record.id, name: record.name, visibility: record.visibility });
}));

// Delete a recipe box (cascades to recipes + events)
dataRoutes.delete("/boxes/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  await pb.collection("recipe_boxes").delete(id);
  try {
    const user = await pb.collection("users").getOne(userId);
    const boxes = (user.recipe_boxes || []) as string[];
    if (boxes.includes(id)) {
      await pb.collection("users").update(userId, { recipe_boxes: boxes.filter((b) => b !== id) });
    }
  } catch {}
  return c.json({ success: true });
}));

// Subscribe authenticated user to a box
dataRoutes.post("/boxes/:id/subscribe", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const user = await pb.collection("users").getOne(userId);
  const boxes = (user.recipe_boxes || []) as string[];
  await Promise.all([
    boxes.includes(id)
      ? Promise.resolve()
      : pb.collection("users").update(userId, { recipe_boxes: [...boxes, id] }),
    pb.collection("recipe_boxes").update(id, { "subscribers+": userId }),
  ]);
  return c.json({ success: true });
}));

// Unsubscribe authenticated user from a box
dataRoutes.post("/boxes/:id/unsubscribe", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const user = await pb.collection("users").getOne(userId);
  const boxes = (user.recipe_boxes || []) as string[];
  await Promise.all([
    pb.collection("users").update(userId, { recipe_boxes: boxes.filter((b) => b !== id) }),
    pb.collection("recipe_boxes").update(id, { "subscribers-": userId }),
  ]);
  return c.json({ success: true });
}));

// Update a recipe (data and/or visibility)
dataRoutes.patch("/recipes/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const body = await c.req.json<{
    data?: Record<string, unknown>;
    visibility?: "private" | "public" | "unlisted";
  }>();
  const updates: Record<string, unknown> = {};
  if (body.data !== undefined) {
    updates.data = body.data;
    updates.last_updated_by = userId;
    updates.enrichment_status = "needed";
    updates.pending_changes = null;
  }
  if (body.visibility !== undefined) updates.visibility = body.visibility;
  if (Object.keys(updates).length === 0) return c.json({ error: "no fields provided" }, 400);

  const record = await pb.collection("recipes").update(id, updates);
  return c.json({
    id: record.id,
    name: (record.data as Record<string, unknown>)?.name,
    visibility: record.visibility,
  });
}));

// Delete a recipe
dataRoutes.delete("/recipes/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  await pb.collection("recipes").delete(id);
  return c.json({ success: true });
}));

// List cooking log events for a recipe
dataRoutes.get("/recipes/:id/cooking-log", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const recipe = await pb.collection("recipes").getOne(id);
  const events = await pb.collection("recipe_events").getFullList({
    filter: pb.filter("box = {:boxId} && subject_id = {:recipeId}", { boxId: recipe.box, recipeId: id }),
    sort: "-timestamp",
  });
  return c.json(events.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    notes: (e.data as Record<string, unknown> | undefined)?.notes,
    created_by: e.created_by,
    created: e.created,
  })));
}));

// Add a cooking log entry for a recipe
dataRoutes.post("/recipes/:id/cooking-log", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const body = await c.req.json<{ notes?: string; timestamp?: string }>().catch(
    () => ({} as { notes?: string; timestamp?: string }),
  );
  const recipe = await pb.collection("recipes").getOne(id);
  const record = await pb.collection("recipe_events").create({
    box: recipe.box,
    subject_id: id,
    timestamp: body.timestamp ?? new Date().toISOString(),
    created_by: userId,
    data: body.notes ? { notes: body.notes } : {},
  });
  return c.json({ id: record.id, timestamp: record.timestamp }, 201);
}));

// Update notes on a cooking log entry (empty string clears notes)
dataRoutes.patch("/cooking-log/:eventId", handler(async (c) => {
  const pb = c.get("pb");
  const eventId = c.req.param("eventId")!;
  const { notes } = await c.req.json<{ notes: string }>();
  const record = await pb.collection("recipe_events").getOne(eventId);
  const data = { ...((record.data as Record<string, unknown>) || {}) };
  const trimmed = (notes ?? "").trim();
  if (trimmed) data.notes = trimmed;
  else delete data.notes;
  const updated = await pb.collection("recipe_events").update(eventId, { data });
  return c.json({
    id: updated.id,
    notes: (updated.data as Record<string, unknown> | undefined)?.notes,
  });
}));

// Delete a cooking log entry
dataRoutes.delete("/cooking-log/:eventId", handler(async (c) => {
  const pb = c.get("pb");
  const eventId = c.req.param("eventId")!;
  await pb.collection("recipe_events").delete(eventId);
  return c.json({ success: true });
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
  });
}));

// Shape every activity response identically — write-side and read-side stay
// in sync so a fetched activity round-trips losslessly.
function activityResponse(a: Record<string, unknown>) {
  return {
    id: a.id,
    log: a.log,
    name: a.name,
    category: a.category,
    location: a.location,
    place_id: a.place_id,
    lat: a.lat,
    lng: a.lng,
    description: a.description,
    cost_notes: a.cost_notes,
    duration_estimate: a.duration_estimate,
    walk_miles: a.walk_miles,
    elevation_gain_feet: a.elevation_gain_feet,
    difficulty: a.difficulty,
    confirmation_code: a.confirmation_code,
    details: a.details,
    setting: a.setting,
    booking_reqs: a.booking_reqs,
    rating: a.rating,
    rating_count: a.rating_count,
    photo_ref: a.photo_ref,
    flight_info: a.flight_info,
    verdict: a.verdict,
    personal_notes: a.personal_notes,
    experienced_at: a.experienced_at,
    trip_id: a.trip_id,
  };
}

// List activities in a travel log (optionally filtered by trip_id)
dataRoutes.get("/travel/activities", handler(async (c) => {
  const pb = c.get("pb");
  const logId = c.req.query("log");
  if (!logId) return c.json({ error: "log query param required" }, 400);
  const tripId = c.req.query("trip_id");

  let filter = pb.filter("log = {:logId}", { logId });
  if (tripId) filter += " && " + pb.filter("trip_id = {:tripId}", { tripId });

  const activities = await pb.collection("travel_activities").getFullList({ filter });
  return c.json(activities.map((a) => activityResponse(a)));
}));

// Get a single travel activity with full data
dataRoutes.get("/travel/activities/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const a = await pb.collection("travel_activities").getOne(id);
  return c.json(activityResponse(a));
}));

// List itineraries in a travel log (optionally filtered by trip_id)
dataRoutes.get("/travel/itineraries", handler(async (c) => {
  const pb = c.get("pb");
  const logId = c.req.query("log");
  if (!logId) return c.json({ error: "log query param required" }, 400);
  const tripId = c.req.query("trip_id");

  let filter = pb.filter("log = {:logId}", { logId });
  if (tripId) filter += " && " + pb.filter("trip_id = {:tripId}", { tripId });

  const itineraries = await pb.collection("travel_itineraries").getFullList({ filter });
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
    trip_id?: string;
    name: string;
    category?: string;
    location?: string;
    description?: string;
    cost_notes?: string;
    duration_estimate?: string;
    walk_miles?: number;
    elevation_gain_feet?: number;
    difficulty?: string;
    setting?: string;
    confirmation_code?: string;
    details?: string;
    flight_info?: Record<string, unknown> | null;
    booking_reqs?: Record<string, unknown> | null;
    verdict?: string;
    personal_notes?: string;
    experienced_at?: string;
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
    walk_miles: body.walk_miles ?? null,
    elevation_gain_feet: body.elevation_gain_feet ?? null,
    difficulty: body.difficulty || "",
    setting: body.setting || "",
    confirmation_code: body.confirmation_code || "",
    details: body.details || "",
    flight_info: body.flight_info ?? null,
    booking_reqs: body.booking_reqs ?? null,
    verdict: body.verdict || "",
    personal_notes: body.personal_notes || "",
    experienced_at: body.experienced_at || "",
  });
  return c.json(activityResponse(record), 201);
}));

// Update a travel activity. Whitelisted to schema fields so callers can't
// accidentally write arbitrary keys.
dataRoutes.patch("/travel/activities/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const body = await c.req.json<Record<string, unknown>>();
  const allowed = [
    "name", "category", "location", "place_id", "lat", "lng",
    "description", "cost_notes", "duration_estimate", "walk_miles",
    "elevation_gain_feet", "difficulty", "confirmation_code",
    "details", "setting", "booking_reqs", "rating", "rating_count",
    "photo_ref", "flight_info", "verdict", "personal_notes", "experienced_at",
    "trip_id",
  ];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key];
  }
  const record = await pb.collection("travel_activities").update(id, updates);
  return c.json(activityResponse(record));
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

// Delete a travel trip
dataRoutes.delete("/travel/trips/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  await pb.collection("travel_trips").delete(id);
  return c.json({ success: true });
}));

// Delete a travel activity
dataRoutes.delete("/travel/activities/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  await pb.collection("travel_activities").delete(id);
  return c.json({ success: true });
}));

// Delete a travel itinerary
dataRoutes.delete("/travel/itineraries/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  await pb.collection("travel_itineraries").delete(id);
  return c.json({ success: true });
}));

// Update a travel itinerary
dataRoutes.patch("/travel/itineraries/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const body = await c.req.json<Record<string, unknown>>();
  const record = await pb.collection("travel_itineraries").update(id, body);
  return c.json({
    id: record.id,
    name: record.name,
    is_active: record.is_active,
    trip_id: record.trip_id,
    days: record.days,
  });
}));

// Geocode a single travel activity using Google Places API
dataRoutes.post("/travel/activities/:id/geocode", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;

  const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return c.json({ error: "VITE_GOOGLE_MAPS_API_KEY not configured on the server" }, 500);
  }

  const activity = await pb.collection("travel_activities").getOne(id);
  const body: { searchQuery?: string } = await c.req.json<{ searchQuery?: string }>().catch(() => ({}));

  async function searchPlace(q: string) {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey!,
        "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.formattedAddress",
      },
      body: JSON.stringify({ textQuery: q }),
    });
    if (!res.ok) throw new Error(`Places API ${res.status}: ${await res.text()}`);
    const data = await res.json() as {
      places?: Array<{ id: string; displayName?: { text: string }; location?: { latitude: number; longitude: number }; formattedAddress?: string }>;
    };
    return data.places?.[0] || null;
  }

  // Flight: geocode both from and to airports into flight_info
  if (activity.category === "Flight") {
    const fi = activity.flight_info || {};
    const fromCode = fi.from as string | undefined;
    const toCode = fi.to as string | undefined;
    if (!fromCode || !toCode) {
      return c.json({ error: "Flight missing from/to airport codes" }, 400);
    }
    const fromPlace = await searchPlace(`${fromCode} airport`);
    const toPlace = await searchPlace(`${toCode} airport`);
    if (!fromPlace || !toPlace) {
      return c.json({ error: `Could not find airports: from=${!!fromPlace} to=${!!toPlace}` }, 404);
    }
    const newFi = {
      ...fi,
      fromLat: fromPlace.location?.latitude,
      fromLng: fromPlace.location?.longitude,
      toLat: toPlace.location?.latitude,
      toLng: toPlace.location?.longitude,
    };
    // Also set the activity's primary lat/lng to the departure airport so
    // it appears somewhere if flight_info is stripped
    const updated = await pb.collection("travel_activities").update(id, {
      flight_info: newFi,
      lat: fromPlace.location?.latitude,
      lng: fromPlace.location?.longitude,
    });
    return c.json({
      id: updated.id,
      name: updated.name,
      flight_info: updated.flight_info,
      fromPlace: fromPlace.displayName?.text,
      toPlace: toPlace.displayName?.text,
    });
  }

  let searchQuery = body.searchQuery;
  if (!searchQuery) {
    // For Transportation activities with a trip, use trip destination + "airport"
    if (activity.category === "Transportation" && activity.trip_id) {
      try {
        const trip = await pb.collection("travel_trips").getOne(activity.trip_id as string);
        searchQuery = `${trip.destination} airport`;
      } catch {
        // Fall through to default
      }
    }
    // Default: activity name + location
    if (!searchQuery) {
      searchQuery = [activity.name, activity.location].filter(Boolean).join(", ");
    }
  }

  if (!searchQuery) {
    return c.json({ error: "Could not construct a search query — activity has no name or location" }, 400);
  }

  const place = await searchPlace(searchQuery);
  if (!place) {
    return c.json({ error: `No places found for query: "${searchQuery}"` }, 404);
  }

  const updated = await pb.collection("travel_activities").update(id, {
    place_id: place.id,
    lat: place.location?.latitude ?? 0,
    lng: place.location?.longitude ?? 0,
  });

  return c.json({
    id: updated.id,
    name: updated.name,
    place_id: updated.place_id,
    lat: updated.lat,
    lng: updated.lng,
    searchQuery,
    placeName: place.displayName?.text,
    formattedAddress: place.formattedAddress,
  });
}));

// Batch geocode travel activities
dataRoutes.post("/travel/activities/batch-geocode", handler(async (c) => {
  const pb = c.get("pb");

  const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return c.json({ error: "VITE_GOOGLE_MAPS_API_KEY not configured on the server" }, 500);
  }

  const body = await c.req.json<{ log: string; trip_id?: string }>();
  if (!body.log) return c.json({ error: "log required" }, 400);

  let filter = pb.filter("log = {:log}", { log: body.log });
  if (body.trip_id) filter += " && " + pb.filter("trip_id = {:tripId}", { tripId: body.trip_id });
  // Only activities without a place_id
  filter += ' && place_id = ""';

  const activities = await pb.collection("travel_activities").getFullList({ filter });
  let geocoded = 0;
  let skipped = 0;
  let errors = 0;
  const details: Array<{ id: string; name: string; status: string; error?: string }> = [];

  for (const activity of activities) {
    // Construct search query
    let searchQuery: string | undefined;

    if (activity.category === "Transportation" && activity.trip_id) {
      try {
        const trip = await pb.collection("travel_trips").getOne(activity.trip_id as string);
        searchQuery = `${trip.destination} airport`;
      } catch {
        // Fall through
      }
    }
    if (!searchQuery) {
      searchQuery = [activity.name, activity.location].filter(Boolean).join(", ");
    }

    if (!searchQuery) {
      skipped++;
      details.push({ id: activity.id, name: activity.name as string, status: "skipped", error: "no name or location" });
      continue;
    }

    try {
      const placesRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.formattedAddress",
        },
        body: JSON.stringify({ textQuery: searchQuery }),
      });

      if (!placesRes.ok) {
        errors++;
        const errBody = await placesRes.text();
        details.push({ id: activity.id, name: activity.name as string, status: "error", error: `Places API ${placesRes.status}: ${errBody}` });
        continue;
      }

      const placesData = await placesRes.json() as {
        places?: Array<{
          id: string;
          location?: { latitude: number; longitude: number };
        }>;
      };

      const place = placesData.places?.[0];
      if (!place) {
        skipped++;
        details.push({ id: activity.id, name: activity.name as string, status: "skipped", error: `no results for "${searchQuery}"` });
        continue;
      }

      await pb.collection("travel_activities").update(activity.id, {
        place_id: place.id,
        lat: place.location?.latitude ?? 0,
        lng: place.location?.longitude ?? 0,
      });

      geocoded++;
      details.push({ id: activity.id, name: activity.name as string, status: "geocoded" });

      // Small delay between API calls to avoid rate limiting
      if (activities.indexOf(activity) < activities.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch (err) {
      errors++;
      details.push({ id: activity.id, name: activity.name as string, status: "error", error: String(err) });
    }
  }

  return c.json({ total: activities.length, geocoded, skipped, errors, details });
}));

// Replace the days array on a travel itinerary
dataRoutes.put("/travel/itineraries/:id/days", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const { days } = await c.req.json<{ days: unknown }>();
  if (days === undefined) return c.json({ error: "days array required" }, 400);

  const record = await pb.collection("travel_itineraries").update(id, { days });
  return c.json({
    id: record.id,
    name: record.name,
    days: record.days,
  });
}));

// ── Targeted itinerary patch ops ────────────────────────────────
// All ops below read days, mutate the named locality, and write back.
// Concurrent callers race at the days-array level — last write wins.
// (Optimistic locking would need a `version` column on travel_itineraries.)
//
// Each op returns the affected day(s) only — clients can splice into local
// state without re-fetching the whole itinerary.

interface ItinerarySlot {
  activityId: string;
  startTime?: string;
  notes?: string;
}
interface ItineraryDay {
  date?: string;
  label: string;
  lodgingActivityId?: string;
  flights?: ItinerarySlot[];
  slots: ItinerarySlot[];
}

type PB = import("pocketbase").default;

async function mutateDays<T>(
  pb: PB,
  id: string,
  fn: (days: ItineraryDay[]) => T | { error: string; status?: number },
): Promise<{ days: ItineraryDay[]; result: T } | { error: string; status: number }> {
  const record = await pb.collection("travel_itineraries").getOne(id);
  const days = ((record.days || []) as ItineraryDay[]).map((d) => ({ ...d, slots: [...(d.slots || [])] }));
  const result = fn(days);
  if (result && typeof result === "object" && "error" in result) {
    return { error: (result as { error: string }).error, status: (result as { status?: number }).status ?? 400 };
  }
  await pb.collection("travel_itineraries").update(id, { days });
  return { days, result: result as T };
}

function parseIdx(s: string | undefined, label: string): number | { error: string } {
  if (s === undefined) return { error: `${label} required` };
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative integer` };
  return n;
}

// Add a slot to a day's slots array (default: append to end).
dataRoutes.post("/travel/itineraries/:id/days/:dayIndex/slots", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  const body = await c.req.json<{
    activity_id: string;
    start_time?: string;
    notes?: string;
    position?: number;
  }>();
  if (!body.activity_id) return c.json({ error: "activity_id required" }, 400);

  const out = await mutateDays(pb, id, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range (have ${days.length})` };
    const slot: ItinerarySlot = { activityId: body.activity_id };
    if (body.start_time) slot.startTime = body.start_time;
    if (body.notes) slot.notes = body.notes;
    const slots = days[dayIdx].slots;
    const pos = body.position ?? slots.length;
    const clamped = Math.max(0, Math.min(slots.length, pos));
    slots.splice(clamped, 0, slot);
    return { day_index: dayIdx, position: clamped, day: days[dayIdx] };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json(out.result);
}));

// Remove a slot from a day.
dataRoutes.delete("/travel/itineraries/:id/days/:dayIndex/slots/:slotIndex", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  const slotIdx = parseIdx(c.req.param("slotIndex"), "slot index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  if (typeof slotIdx === "object") return c.json({ error: slotIdx.error }, 400);

  const out = await mutateDays(pb, id, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range` };
    const slots = days[dayIdx].slots;
    if (slotIdx >= slots.length) return { error: `slot index ${slotIdx} out of range` };
    const removed = slots.splice(slotIdx, 1)[0];
    return { day_index: dayIdx, removed, day: days[dayIdx] };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json(out.result);
}));

// Update a slot's fields (startTime, notes, activityId).
dataRoutes.patch("/travel/itineraries/:id/days/:dayIndex/slots/:slotIndex", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  const slotIdx = parseIdx(c.req.param("slotIndex"), "slot index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  if (typeof slotIdx === "object") return c.json({ error: slotIdx.error }, 400);
  const body = await c.req.json<{
    activity_id?: string;
    start_time?: string | null;
    notes?: string | null;
  }>();

  const out = await mutateDays(pb, id, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range` };
    const slots = days[dayIdx].slots;
    if (slotIdx >= slots.length) return { error: `slot index ${slotIdx} out of range` };
    const slot = slots[slotIdx];
    if (body.activity_id !== undefined) slot.activityId = body.activity_id;
    // null clears the optional field; undefined leaves it alone.
    if (body.start_time === null) delete slot.startTime;
    else if (body.start_time !== undefined) slot.startTime = body.start_time;
    if (body.notes === null) delete slot.notes;
    else if (body.notes !== undefined) slot.notes = body.notes;
    return { day_index: dayIdx, slot_index: slotIdx, day: days[dayIdx] };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json(out.result);
}));

// Update a day's metadata (label, date, lodging).
dataRoutes.patch("/travel/itineraries/:id/days/:dayIndex", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const dayIdx = parseIdx(c.req.param("dayIndex"), "day index");
  if (typeof dayIdx === "object") return c.json({ error: dayIdx.error }, 400);
  const body = await c.req.json<{
    label?: string;
    date?: string | null;
    lodging_activity_id?: string | null;
  }>();

  const out = await mutateDays(pb, id, (days) => {
    if (dayIdx >= days.length) return { error: `day index ${dayIdx} out of range` };
    const day = days[dayIdx];
    if (body.label !== undefined) day.label = body.label;
    if (body.date === null) delete day.date;
    else if (body.date !== undefined) day.date = body.date;
    if (body.lodging_activity_id === null) delete day.lodgingActivityId;
    else if (body.lodging_activity_id !== undefined) day.lodgingActivityId = body.lodging_activity_id;
    return { day_index: dayIdx, day };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json(out.result);
}));

// Move a slot — within a day (reorder) or to a different day (transfer).
dataRoutes.post("/travel/itineraries/:id/days/:dayIndex/slots/:slotIndex/move", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const fromDay = parseIdx(c.req.param("dayIndex"), "day index");
  const fromSlot = parseIdx(c.req.param("slotIndex"), "slot index");
  if (typeof fromDay === "object") return c.json({ error: fromDay.error }, 400);
  if (typeof fromSlot === "object") return c.json({ error: fromSlot.error }, 400);
  const body = await c.req.json<{ to_day_index: number; to_position?: number }>();
  if (typeof body.to_day_index !== "number") return c.json({ error: "to_day_index required" }, 400);

  const out = await mutateDays(pb, id, (days) => {
    if (fromDay >= days.length) return { error: `from day_index ${fromDay} out of range` };
    if (body.to_day_index >= days.length) return { error: `to_day_index ${body.to_day_index} out of range` };
    const fromSlots = days[fromDay].slots;
    if (fromSlot >= fromSlots.length) return { error: `slot index ${fromSlot} out of range` };
    const slot = fromSlots.splice(fromSlot, 1)[0];
    const toSlots = days[body.to_day_index].slots;
    // If reordering within the same day after splice, the target indices have shifted —
    // but because we removed first and `splice` mutates in place, toSlots reflects the
    // post-removal state, so to_position is interpreted against that.
    const pos = body.to_position ?? toSlots.length;
    const clamped = Math.max(0, Math.min(toSlots.length, pos));
    toSlots.splice(clamped, 0, slot);
    return {
      from_day_index: fromDay,
      to_day_index: body.to_day_index,
      to_position: clamped,
      from_day: days[fromDay],
      to_day: days[body.to_day_index],
    };
  });
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json(out.result);
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

// Add a life log entry. Mirrors LifeBackend.addEntry: notes (if given) merge
// into the data JSON under `notes`.
dataRoutes.post("/life/entries", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const body = await c.req.json<{
    log: string;
    widget_id: string;
    data?: Record<string, unknown>;
    timestamp?: string;
    notes?: string;
  }>();
  if (!body.log || !body.widget_id) return c.json({ error: "log and widget_id required" }, 400);

  const eventData: Record<string, unknown> = { ...(body.data || {}) };
  if (body.notes) eventData.notes = body.notes;

  const record = await pb.collection("life_events").create({
    log: body.log,
    subject_id: body.widget_id,
    timestamp: body.timestamp || new Date().toISOString(),
    created_by: userId,
    data: eventData,
  });
  return c.json({ id: record.id, timestamp: record.timestamp }, 201);
}));

// Update a life log entry — timestamp, data (merged), or notes
dataRoutes.patch("/life/entries/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const body = await c.req.json<{
    timestamp?: string;
    data?: Record<string, unknown>;
    notes?: string;
  }>();
  const record = await pb.collection("life_events").getOne(id);
  const patch: Record<string, unknown> = {};
  if (body.timestamp) patch.timestamp = body.timestamp;
  const existingData = (record.data || {}) as Record<string, unknown>;
  if (body.data || body.notes !== undefined) {
    const merged = body.data ? { ...existingData, ...body.data } : { ...existingData };
    if (body.notes !== undefined) merged.notes = body.notes;
    patch.data = merged;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "no fields provided" }, 400);

  const updated = await pb.collection("life_events").update(id, patch);
  return c.json({ id: updated.id, timestamp: updated.timestamp, data: updated.data });
}));

// Delete a life log entry
dataRoutes.delete("/life/entries/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  await pb.collection("life_events").delete(id);
  return c.json({ success: true });
}));

// ---- Upkeep ----

// List task lists owned by the authenticated user. Tasks are scoped to a
// list, so callers (especially MCP clients) need this to discover list IDs
// before calling /tasks?list=…
dataRoutes.get("/task-lists", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const lists = await pb.collection("task_lists").getFullList({
    filter: pb.filter("owners ~ {:userId}", { userId }),
    sort: "name",
  });
  return c.json(lists.map((l) => ({ id: l.id, name: l.name })));
}));

// List tasks (supports filtering by parent_id, tag, task_type)
dataRoutes.get("/tasks", handler(async (c) => {
  const pb = c.get("pb");
  const listId = c.req.query("list");
  if (!listId) return c.json({ error: "list query param required" }, 400);

  const filters = [pb.filter("list = {:listId}", { listId })];
  const parentId = c.req.query("parent_id");
  if (parentId !== undefined) filters.push(pb.filter("parent_id = {:parentId}", { parentId }));
  const tag = c.req.query("tag");
  if (tag) filters.push(pb.filter("tags ~ {:tag}", { tag }));
  const taskType = c.req.query("task_type");
  if (taskType) filters.push(pb.filter("task_type = {:taskType}", { taskType }));

  const tasks = await pb.collection("tasks").getFullList({
    filter: filters.join(" && "),
    sort: "position",
  });
  return c.json(tasks.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    parent_id: t.parent_id,
    path: t.path,
    position: t.position,
    task_type: t.task_type,
    frequency: t.frequency,
    last_completed: t.last_completed,
    completed: t.completed,
    snoozed_until: t.snoozed_until,
    tags: t.tags,
    collapsed: t.collapsed,
  })));
}));

// Create a task
dataRoutes.post("/tasks", handler(async (c) => {
  const pb = c.get("pb");
  const body = await c.req.json<{
    list: string;
    name: string;
    description?: string;
    parent_id?: string;
    position?: number;
    task_type?: string;
    frequency?: unknown;
    tags?: string[];
  }>();
  if (!body.list || !body.name) return c.json({ error: "list and name required" }, 400);

  const record = await pb.collection("tasks").create({
    list: body.list,
    name: body.name,
    description: body.description || "",
    parent_id: body.parent_id || "",
    position: body.position ?? 0,
    task_type: body.task_type || "one_shot",
    frequency: body.frequency || 0,
    tags: body.tags || [],
  });

  // Set path after creation (needs the ID)
  let path = record.id;
  if (body.parent_id) {
    const parent = await pb.collection("tasks").getOne(body.parent_id);
    path = `${parent.path}/${record.id}`;
  }
  await pb.collection("tasks").update(record.id, { path });

  return c.json({ id: record.id, name: record.name }, 201);
}));

// Update a task
dataRoutes.patch("/tasks/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const body = await c.req.json<Record<string, unknown>>();
  const allowed = ["name", "description", "task_type", "frequency", "position",
    "completed", "snoozed_until", "tags", "collapsed", "notify_users", "parent_id"];
  const data: Record<string, unknown> = {};
  for (const key of allowed) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  const record = await pb.collection("tasks").update(id, data);
  return c.json({ id: record.id, name: record.name });
}));

// Complete a task (recurring: adds a task_events record + refreshes
// last_completed; one_shot: toggles the completed flag)
dataRoutes.post("/tasks/:id/complete", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;
  const task = await pb.collection("tasks").getOne(id);

  if (task.task_type === "one_shot") {
    const record = await pb.collection("tasks").update(id, { completed: !task.completed });
    return c.json({ id: record.id, completed: record.completed });
  }

  const now = new Date().toISOString();
  await pb.collection("task_events").create({
    list: task.list,
    subject_id: id,
    timestamp: now,
    created_by: userId,
    data: {},
  });
  // Recompute last_completed from the max event timestamp — keeps it honest
  // when events pre-date this one (backfills) or are later edited/deleted.
  const latestEvents = await pb.collection("task_events").getList(1, 1, {
    filter: `subject_id="${id}"`,
    sort: "-timestamp",
  });
  const latest = latestEvents.items[0]?.timestamp ?? now;
  const record = await pb.collection("tasks").update(id, {
    last_completed: latest,
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

// Unsnooze a task (clear snoozed_until)
dataRoutes.post("/tasks/:id/unsnooze", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const record = await pb.collection("tasks").update(id, { snoozed_until: "" });
  return c.json({ id: record.id, snoozed_until: record.snoozed_until });
}));

// Delete a task (and all descendants)
dataRoutes.delete("/tasks/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const task = await pb.collection("tasks").getOne(id);

  // Delete descendants first (deepest first)
  const descendants = await pb.collection("tasks").getFullList({
    filter: pb.filter("path ~ {:prefix}", { prefix: `${task.path}/%` }),
  });
  descendants.sort((a, b) => b.path.length - a.path.length);
  for (const d of descendants) {
    await pb.collection("tasks").delete(d.id);
  }
  await pb.collection("tasks").delete(id);
  return c.json({ deleted: true });
}));

// ---- Trip Proposals ----

function proposalResponse(r: Record<string, unknown>) {
  return {
    id: r.id,
    trip: r.trip,
    question: r.question,
    reasoning: r.reasoning,
    candidate_ids: r.candidate_ids,
    claude_picks: r.claude_picks,
    feedback: r.feedback,
    overall_feedback: r.overall_feedback,
    state: r.state,
    resolved_at: r.resolved_at,
    user_responded_at: r.user_responded_at,
    claude_last_seen_at: r.claude_last_seen_at,
    created: r.created,
    updated: r.updated,
  };
}

/** Returns true if the caller is an API-token (Claude) request. */
function isClaude(c: { get(k: string): unknown }): boolean {
  return !!c.get("isApiKey");
}

/** A proposal is unread when user has responded since Claude last saw it. */
function isUnreadByClaude(r: Record<string, unknown>): boolean {
  const responded = r.user_responded_at as string | undefined;
  if (!responded) return false;
  const seen = r.claude_last_seen_at as string | undefined;
  return !seen || responded > seen;
}

// List proposals for a trip.
// When called as Claude (API token) with unread_only=true, only returns
// proposals where the user has responded since Claude last looked.
// Claude reads auto-bump claude_last_seen_at on each returned proposal.
dataRoutes.get("/travel/proposals", handler(async (c) => {
  const pb = c.get("pb");
  const tripId = c.req.query("trip");
  if (!tripId) return c.json({ error: "trip query param required" }, 400);
  const state = c.req.query("state");
  const unreadOnly = c.req.query("unread_only") === "true";

  let filter = pb.filter("trip = {:tripId}", { tripId });
  if (state) filter += ` && state = "${state}"`;
  let records = await pb.collection("trip_proposals").getFullList({
    filter,
    sort: "-created",
  });

  if (unreadOnly) {
    records = records.filter((r) => isUnreadByClaude(r));
  }

  // If Claude is reading, mark each returned proposal as seen.
  if (isClaude(c) && records.length > 0) {
    const now = new Date().toISOString();
    await Promise.all(records.map((r) =>
      pb.collection("trip_proposals").update(r.id, { claude_last_seen_at: now })
    ));
    // Reflect the bump in the response
    for (const r of records) (r as { claude_last_seen_at?: string }).claude_last_seen_at = now;
  }

  return c.json(records.map(proposalResponse));
}));

// Get a proposal. Marks it as seen when Claude reads.
dataRoutes.get("/travel/proposals/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const r = await pb.collection("trip_proposals").getOne(id);
  if (isClaude(c)) {
    const now = new Date().toISOString();
    await pb.collection("trip_proposals").update(id, { claude_last_seen_at: now });
    (r as { claude_last_seen_at?: string }).claude_last_seen_at = now;
  }
  return c.json(proposalResponse(r));
}));

// Create a proposal
dataRoutes.post("/travel/proposals", handler(async (c) => {
  const pb = c.get("pb");
  const body = await c.req.json<{
    trip: string;
    question: string;
    reasoning?: string;
    candidate_ids?: string[];
    claude_picks?: string[];
    feedback?: Record<string, unknown>;
    overall_feedback?: string;
  }>();
  if (!body.trip || !body.question) return c.json({ error: "trip and question required" }, 400);

  const record = await pb.collection("trip_proposals").create({
    trip: body.trip,
    question: body.question,
    reasoning: body.reasoning || "",
    candidate_ids: body.candidate_ids || [],
    claude_picks: body.claude_picks || [],
    feedback: body.feedback || {},
    overall_feedback: body.overall_feedback || "",
    state: "open",
  });
  return c.json(proposalResponse(record), 201);
}));

// Update a proposal. Claude revising (API token) doesn't bump user_responded_at;
// user edits (feedback/picks/votes/state change) do bump it.
dataRoutes.patch("/travel/proposals/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const body = await c.req.json<Record<string, unknown>>();
  const allowed = [
    "question", "reasoning", "candidate_ids", "claude_picks",
    "feedback", "overall_feedback", "state", "resolved_at",
  ];
  const data: Record<string, unknown> = {};
  for (const k of allowed) {
    if (body[k] !== undefined) data[k] = body[k];
  }

  // If the user (not Claude) touched any response-related field, bump the
  // responded timestamp so Claude can detect it.
  const userResponseFields = new Set(["feedback", "overall_feedback", "state"]);
  const userResponded = !isClaude(c) && Object.keys(data).some((k) => userResponseFields.has(k));
  if (userResponded) {
    data.user_responded_at = new Date().toISOString();
  }

  const record = await pb.collection("trip_proposals").update(id, data);
  return c.json(proposalResponse(record));
}));

// Resolve a proposal (convenience endpoint — sets state + resolved_at).
// Always counts as a user response if called by the user.
dataRoutes.post("/travel/proposals/:id/resolve", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const patch: Record<string, unknown> = {
    state: "resolved",
    resolved_at: new Date().toISOString(),
  };
  if (!isClaude(c)) patch.user_responded_at = new Date().toISOString();
  const record = await pb.collection("trip_proposals").update(id, patch);
  return c.json(proposalResponse(record));
}));

// Delete a proposal
dataRoutes.delete("/travel/proposals/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  await pb.collection("trip_proposals").delete(id);
  return c.json({ deleted: true });
}));

// =============================================================================
// Monitor — deployment history
// =============================================================================

// Record a deployment. Called by infra/deploy.sh after each run.
dataRoutes.post("/deployments", handler(async (c) => {
  const pb = c.get("pb");
  const body = await c.req.json<{
    git_sha: string;
    git_branch?: string;
    git_subject?: string;
    apps?: string[];
    duration_seconds?: number;
    status: "success" | "failure" | "partial";
    deployer?: string;
    host?: string;
    notes?: string;
    failed_apps?: string[];
  }>();

  if (!body.git_sha || !body.status) {
    return c.json({ error: "git_sha and status required" }, 400);
  }
  if (!["success", "failure", "partial"].includes(body.status)) {
    return c.json({ error: "invalid status" }, 400);
  }

  const record = await pb.collection("deployments").create({
    git_sha: body.git_sha,
    git_branch: body.git_branch ?? "",
    git_subject: body.git_subject ?? "",
    apps: body.apps ?? [],
    duration_seconds: body.duration_seconds ?? 0,
    status: body.status,
    deployer: body.deployer ?? "",
    host: body.host ?? "",
    notes: body.notes ?? "",
    failed_apps: body.failed_apps ?? [],
  });
  return c.json({ id: record.id }, 201);
}));

// List recent deployments (newest first).
dataRoutes.get("/deployments", handler(async (c) => {
  const pb = c.get("pb");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 500);
  const records = await pb.collection("deployments").getList(1, limit, {
    sort: "-created",
  });
  return c.json(records.items.map((r) => ({
    id: r.id,
    created: r.created,
    git_sha: r.git_sha,
    git_branch: r.git_branch,
    git_subject: r.git_subject,
    apps: r.apps,
    duration_seconds: r.duration_seconds,
    status: r.status,
    deployer: r.deployer,
    host: r.host,
    notes: r.notes,
    failed_apps: r.failed_apps,
  })));
}));

// Delete a deployment record (for cleaning up stray entries).
dataRoutes.delete("/deployments/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  await pb.collection("deployments").delete(id);
  return c.json({ deleted: true });
}));
