/**
 * MCP server exposing homelab recipe, shopping, and upkeep data as tools.
 * Calls the HTTP API internally so it goes through the same auth and business logic.
 *
 * Run with: pnpm mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { API_BASE } from "./config";
const API_TOKEN = process.env.HOMELAB_API_TOKEN || "";

if (!API_TOKEN) {
  console.error("HOMELAB_API_TOKEN env var is required. Generate one in Settings → API Tokens.");
  process.exit(1);
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${API_BASE}/data${path}`;
  return apiFetch(url, init);
}

/** Call a non-data route (e.g. /recipes/scrape, /ai/generate, /sharing/invite) */
async function apiRaw(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  return apiFetch(url, init);
}

async function apiFetch(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

const server = new McpServer({
  name: "homelab",
  version: "0.1.0",
});

// --- Recipe tools ---

server.tool(
  "list_boxes",
  "List all recipe boxes for the authenticated user",
  {},
  async () => {
    const data = await api("/boxes");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "search_recipes",
  "Search recipes by name across all boxes. Returns matching recipes with their box and basic info.",
  { query: z.string().describe("Search term to match against recipe names (case-insensitive)") },
  async ({ query }) => {
    const boxes = (await api("/boxes")) as Array<{ id: string; name: string }>;
    const allRecipes: unknown[] = [];
    for (const box of boxes) {
      const recipes = (await api(`/recipes?boxId=${box.id}`)) as Array<{
        id: string;
        name?: string;
        description?: string;
        [k: string]: unknown;
      }>;
      const matches = recipes.filter(
        (r) => r.name && r.name.toLowerCase().includes(query.toLowerCase()),
      );
      allRecipes.push(
        ...matches.map((r) => ({ ...r, boxName: box.name })),
      );
    }
    return {
      content: [
        {
          type: "text",
          text: allRecipes.length
            ? JSON.stringify(allRecipes, null, 2)
            : `No recipes found matching "${query}"`,
        },
      ],
    };
  },
);

server.tool(
  "get_recipe",
  "Get full recipe details by ID, including ingredients, steps, and enrichment data",
  { id: z.string().describe("The recipe record ID") },
  async ({ id }) => {
    const data = await api(`/recipes/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Shopping tools ---

server.tool(
  "list_shopping_lists",
  "List all shopping lists for the authenticated user",
  {},
  async () => {
    const data = await api("/shopping/lists");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "list_shopping_items",
  "List items in a shopping list",
  { list: z.string().describe("The shopping list ID") },
  async ({ list }) => {
    const data = await api(`/shopping/items?list=${list}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "add_shopping_item",
  "Add an item to a shopping list",
  {
    list: z.string().describe("The shopping list ID"),
    ingredient: z.string().describe("Name of the item to add"),
    note: z.string().optional().describe("Optional note for the item"),
    category_id: z.string().optional().describe("Optional category ID (defaults to 'uncategorized')"),
  },
  async ({ list, ingredient, note, category_id }) => {
    const data = await api("/shopping/items", {
      method: "POST",
      body: JSON.stringify({ list, ingredient, note, category_id }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Upkeep tools ---

server.tool(
  "list_tasks",
  "List tasks in a task list. Supports filtering by parent_id, tag, and task_type.",
  {
    list: z.string().describe("The task list ID"),
    parent_id: z.string().optional().describe("Filter by parent task ID (empty string for root tasks)"),
    tag: z.string().optional().describe("Filter by tag (e.g. 'travel:tripId123')"),
    task_type: z.string().optional().describe("Filter by type: 'recurring' or 'one_shot'"),
  },
  async ({ list, parent_id, tag, task_type }) => {
    const params = new URLSearchParams({ list });
    if (parent_id !== undefined) params.set("parent_id", parent_id);
    if (tag) params.set("tag", tag);
    if (task_type) params.set("task_type", task_type);
    const data = await api(`/tasks?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Travel tools ---

server.tool(
  "list_travel_trips",
  "List travel trips (summary view — use get_travel_trip for full details). Optionally filter by status.",
  {
    status: z.string().optional().describe("Filter by status: Completed, Booked, Researching, Idea, Ongoing"),
  },
  async ({ status }) => {
    const logs = (await api("/travel/logs")) as Array<{ id: string; slug: string; name: string }>;
    const allTrips: Array<Record<string, unknown>> = [];
    for (const log of logs) {
      const qs = status ? `&status=${encodeURIComponent(status)}` : "";
      const trips = (await api(`/travel/trips?log=${log.id}${qs}`)) as Array<Record<string, unknown>>;
      allTrips.push(...trips.map((t) => ({ ...t, logName: log.name })));
    }
    // Sort by status priority: Ongoing > Booked > Researching > Idea > Completed
    const statusOrder: Record<string, number> = {
      Ongoing: 0, Booked: 1, Researching: 2, Idea: 3, Completed: 4,
    };
    allTrips.sort((a, b) => {
      const oa = statusOrder[String(a.status)] ?? 3;
      const ob = statusOrder[String(b.status)] ?? 3;
      return oa - ob;
    });
    return { content: [{ type: "text", text: JSON.stringify(allTrips, null, 2) }] };
  },
);

server.tool(
  "get_travel_trip",
  "Get full details for a single trip including notes, activities, and itineraries",
  { id: z.string().describe("The travel trip record ID") },
  async ({ id }) => {
    // Get full trip details directly
    const trip = (await api(`/travel/trips/${id}`)) as Record<string, unknown>;
    const logId = trip.log as string;
    // Fetch related activities and itineraries (filtered server-side by trip_id)
    const [tripActivities, tripItineraries] = await Promise.all([
      api(`/travel/activities?log=${logId}&trip_id=${id}`) as Promise<Array<Record<string, unknown>>>,
      api(`/travel/itineraries?log=${logId}&trip_id=${id}`) as Promise<Array<Record<string, unknown>>>,
    ]);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ...trip, activities: tripActivities, itineraries: tripItineraries }, null, 2),
      }],
    };
  },
);

server.tool(
  "search_travel",
  "Search travel trips and activities by name or destination",
  { query: z.string().describe("Search term to match against trip destinations and activity names (case-insensitive)") },
  async ({ query }) => {
    const logs = (await api("/travel/logs")) as Array<{ id: string; slug: string; name: string }>;
    const matchingTrips: unknown[] = [];
    const matchingActivities: unknown[] = [];
    const q = query.toLowerCase();
    for (const log of logs) {
      const [trips, activities] = await Promise.all([
        api(`/travel/trips?log=${log.id}`) as Promise<Array<Record<string, unknown>>>,
        api(`/travel/activities?log=${log.id}`) as Promise<Array<Record<string, unknown>>>,
      ]);
      matchingTrips.push(
        ...trips
          .filter((t) => String(t.destination || "").toLowerCase().includes(q) || String(t.region || "").toLowerCase().includes(q))
          .map((t) => ({ ...t, logName: log.name })),
      );
      matchingActivities.push(
        ...activities
          .filter((a) => String(a.name || "").toLowerCase().includes(q) || String(a.location || "").toLowerCase().includes(q))
          .map((a) => ({ ...a, logName: log.name })),
      );
    }
    const result = { trips: matchingTrips, activities: matchingActivities };
    const total = matchingTrips.length + matchingActivities.length;
    return {
      content: [{
        type: "text",
        text: total ? JSON.stringify(result, null, 2) : `No travel results matching "${query}"`,
      }],
    };
  },
);

// --- Life tools ---

server.tool(
  "list_life_entries",
  "List recent life log entries. Defaults to the last 7 days.",
  { days: z.number().optional().describe("Number of days to look back (default 7)") },
  async ({ days }) => {
    const log = (await api("/life/log")) as { id: string; name: string; manifest: unknown };
    const entries = (await api(`/life/entries?log=${log.id}`)) as Array<{
      id: string;
      subject_id: string;
      timestamp: string;
      data: unknown;
      [k: string]: unknown;
    }>;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days ?? 7));
    const recent = entries.filter((e) => new Date(e.timestamp) >= cutoff);
    return {
      content: [{
        type: "text",
        text: recent.length
          ? JSON.stringify(recent, null, 2)
          : `No life entries in the last ${days ?? 7} days`,
      }],
    };
  },
);

// --- Shopping write tools ---

server.tool(
  "check_shopping_item",
  "Toggle the checked status of a shopping item",
  {
    id: z.string().describe("The shopping item ID"),
    checked: z.boolean().describe("Whether the item is checked"),
  },
  async ({ id, checked }) => {
    const data = await api(`/shopping/items/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ checked }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "remove_shopping_item",
  "Delete a shopping item from a list",
  { id: z.string().describe("The shopping item ID to delete") },
  async ({ id }) => {
    const data = await api(`/shopping/items/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "clear_checked_items",
  "Remove all checked items from a shopping list (done shopping)",
  { list: z.string().describe("The shopping list ID") },
  async ({ list }) => {
    const data = await api("/shopping/clear-checked", {
      method: "POST",
      body: JSON.stringify({ list }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Recipe write tools ---

server.tool(
  "scrape_recipe",
  "Scrape a recipe from a URL. Returns structured recipe data.",
  { url: z.string().describe("The URL of the recipe page to scrape") },
  async ({ url }) => {
    const data = await apiRaw("/recipes/scrape", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "generate_recipe",
  "Generate a recipe from a text prompt using AI",
  { prompt: z.string().describe("Description of the recipe to generate (e.g. 'spicy Thai basil chicken')") },
  async ({ prompt }) => {
    const data = await apiRaw("/ai/generate", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "create_recipe_box",
  "Create a new recipe box",
  {
    name: z.string().describe("Name of the recipe box"),
    description: z.string().optional().describe("Optional description"),
  },
  async ({ name, description }) => {
    const data = await api("/boxes", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "add_recipe_to_box",
  "Create a recipe in a recipe box",
  {
    boxId: z.string().describe("The recipe box ID"),
    data: z.object({
      name: z.string().describe("Recipe name"),
      description: z.string().optional().describe("Recipe description"),
      recipeIngredient: z.array(z.string()).optional().describe("List of ingredients"),
      recipeInstructions: z.array(z.object({ text: z.string() })).optional().describe("List of instruction steps"),
      recipeCategory: z.array(z.string()).optional().describe("Recipe tags/categories"),
    }).describe("Recipe data object"),
  },
  async ({ boxId, data }) => {
    const result = await api("/recipes", {
      method: "POST",
      body: JSON.stringify({ boxId, data }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// --- Travel write tools ---

server.tool(
  "add_travel_trip",
  "Create a new travel trip in a log",
  {
    log: z.string().describe("The travel log ID"),
    destination: z.string().describe("Trip destination"),
    status: z.enum(["Completed", "Booked", "Researching", "Idea", "Ongoing"]).optional().describe("Trip status (default: Idea)"),
    region: z.string().optional().describe("Geographic region"),
    start_date: z.string().optional().describe("Start date (ISO format)"),
    end_date: z.string().optional().describe("End date (ISO format)"),
    notes: z.string().optional().describe("Trip notes"),
  },
  async ({ log, destination, status, region, start_date, end_date, notes }) => {
    const data = await api("/travel/trips", {
      method: "POST",
      body: JSON.stringify({ log, destination, status, region, start_date, end_date, notes }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_travel_trip",
  "Update fields on an existing travel trip",
  {
    id: z.string().describe("The trip record ID"),
    destination: z.string().optional().describe("Trip destination"),
    status: z.enum(["Completed", "Booked", "Researching", "Idea", "Ongoing"]).optional().describe("Trip status"),
    region: z.string().optional().describe("Geographic region"),
    start_date: z.string().optional().describe("Start date (ISO format)"),
    end_date: z.string().optional().describe("End date (ISO format)"),
    notes: z.string().optional().describe("Trip notes"),
  },
  async ({ id, ...fields }) => {
    // Only send non-undefined fields
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) body[k] = v;
    }
    const data = await api(`/travel/trips/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "add_travel_activity",
  "Create a new activity in a travel log",
  {
    log: z.string().describe("The travel log ID"),
    trip_id: z.string().optional().describe("The trip this activity belongs to"),
    name: z.string().describe("Activity name"),
    category: z.string().optional().describe("Activity category"),
    location: z.string().optional().describe("Location"),
    description: z.string().optional().describe("Description"),
    cost_notes: z.string().optional().describe("Cost notes"),
    duration_estimate: z.string().optional().describe("Duration estimate"),
    setting: z.string().optional().describe("Setting (indoor/outdoor)"),
  },
  async ({ log, trip_id, name, category, location, description, cost_notes, duration_estimate, setting }) => {
    const data = await api("/travel/activities", {
      method: "POST",
      body: JSON.stringify({ log, trip_id, name, category, location, description, cost_notes, duration_estimate, setting }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_travel_activity",
  "Update fields on an existing travel activity",
  {
    id: z.string().describe("The activity record ID"),
    name: z.string().optional().describe("Activity name"),
    category: z.string().optional().describe("Activity category"),
    location: z.string().optional().describe("Location"),
    description: z.string().optional().describe("Description"),
    cost_notes: z.string().optional().describe("Cost notes"),
    duration_estimate: z.string().optional().describe("Duration estimate"),
    setting: z.string().optional().describe("Setting"),
    trip_id: z.string().optional().describe("Trip ID to associate with"),
  },
  async ({ id, ...fields }) => {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) body[k] = v;
    }
    const data = await api(`/travel/activities/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "add_travel_itinerary",
  "Create a new itinerary for a trip",
  {
    log: z.string().describe("The travel log ID"),
    trip_id: z.string().describe("The trip this itinerary belongs to"),
    name: z.string().describe("Itinerary name"),
    is_active: z.boolean().optional().describe("Whether this is the active itinerary (default: false)"),
    days: z.unknown().optional().describe("Day-by-day plan data"),
  },
  async ({ log, trip_id, name, is_active, days }) => {
    const data = await api("/travel/itineraries", {
      method: "POST",
      body: JSON.stringify({ log, trip_id, name, is_active, days }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Travel delete tools ---

server.tool(
  "delete_travel_trip",
  "Delete a travel trip by ID",
  { id: z.string().describe("The trip record ID to delete") },
  async ({ id }) => {
    const data = await api(`/travel/trips/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "delete_travel_activity",
  "Delete a travel activity by ID",
  { id: z.string().describe("The activity record ID to delete") },
  async ({ id }) => {
    const data = await api(`/travel/activities/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "delete_travel_itinerary",
  "Delete a travel itinerary by ID",
  { id: z.string().describe("The itinerary record ID to delete") },
  async ({ id }) => {
    const data = await api(`/travel/itineraries/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Travel itinerary update tool ---

server.tool(
  "update_travel_itinerary",
  "Update an existing itinerary. If days is provided, it replaces the entire day-by-day plan.",
  {
    id: z.string().describe("The itinerary record ID"),
    name: z.string().optional().describe("Itinerary name"),
    is_active: z.boolean().optional().describe("Whether this is the active itinerary"),
    days: z.array(z.object({
      date: z.string().optional().describe("Date for this day (ISO format)"),
      label: z.string().describe("Day label (e.g. 'Day 1 — Arrival')"),
      lodgingActivityId: z.string().optional().describe("Activity ID for lodging"),
      slots: z.array(z.object({
        activityId: z.string().describe("Activity ID"),
        startTime: z.string().optional().describe("Start time (e.g. '09:00')"),
        notes: z.string().optional().describe("Slot-specific notes"),
      })).describe("Activity slots for this day"),
      flights: z.array(z.unknown()).optional().describe("Flight data for this day"),
    })).optional().describe("Complete day-by-day plan (replaces existing days)"),
  },
  async ({ id, ...fields }) => {
    // Build the update body from provided fields
    const body: Record<string, unknown> = {};
    if (fields.name !== undefined) body.name = fields.name;
    if (fields.is_active !== undefined) body.is_active = fields.is_active;

    // If days provided, use the dedicated PUT endpoint for the array replacement,
    // plus PATCH for any metadata fields
    if (fields.days !== undefined) {
      const requests = [
        api(`/travel/itineraries/${id}/days`, {
          method: "PUT",
          body: JSON.stringify({ days: fields.days }),
        }),
      ];
      if (Object.keys(body).length > 0) {
        requests.push(
          api(`/travel/itineraries/${id}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          }),
        );
      }
      await Promise.all(requests);
      // Return the final merged state
      const final = await api(`/travel/itineraries/${id}`, {
        method: "PATCH",
        body: JSON.stringify({}),
      });
      return { content: [{ type: "text", text: JSON.stringify(final, null, 2) }] };
    }

    // No days — just PATCH the metadata fields
    const data = await api(`/travel/itineraries/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Upkeep write tools ---

server.tool(
  "add_task",
  "Create a task. Supports nesting (parent_id), task types (recurring/one_shot), and tags.",
  {
    list: z.string().describe("The task list ID"),
    name: z.string().describe("Task name"),
    description: z.string().optional().describe("Task description"),
    parent_id: z.string().optional().describe("Parent task ID for nesting (omit for root task)"),
    position: z.number().optional().describe("Sort position among siblings (default 0)"),
    task_type: z.string().optional().describe("'recurring' (has frequency/due dates) or 'one_shot' (checkbox). Default: one_shot"),
    frequency: z.object({
      value: z.number(),
      unit: z.enum(["days", "weeks", "months"]),
    }).optional().describe("Recurrence frequency (only for recurring tasks)"),
    tags: z.array(z.string()).optional().describe("Tags (e.g. ['travel:tripId123'])"),
  },
  async ({ list, name, description, parent_id, position, task_type, frequency, tags }) => {
    const data = await api("/tasks", {
      method: "POST",
      body: JSON.stringify({ list, name, description, parent_id, position, task_type, frequency, tags }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_task",
  "Update task fields (name, description, task_type, frequency, position, completed, tags, etc.)",
  {
    id: z.string().describe("The task record ID"),
    updates: z.record(z.unknown()).describe("Fields to update (e.g. {name: 'New name', completed: true})"),
  },
  async ({ id, updates }) => {
    const data = await api(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "delete_task",
  "Delete a task and all its children",
  { id: z.string().describe("The task record ID") },
  async ({ id }) => {
    const data = await api(`/tasks/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "complete_task",
  "Toggle task completion. Recurring: sets last_completed to now. One-shot: toggles completed boolean.",
  { id: z.string().describe("The task record ID") },
  async ({ id }) => {
    const data = await api(`/tasks/${id}/complete`, { method: "POST" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "snooze_task",
  "Snooze a task until a given date",
  {
    id: z.string().describe("The task record ID"),
    until: z.string().describe("ISO date to snooze until (e.g. 2026-04-20)"),
  },
  async ({ id, until }) => {
    const data = await api(`/tasks/${id}/snooze`, {
      method: "POST",
      body: JSON.stringify({ until }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Geocoding tools ---

server.tool(
  "geocode_activity",
  "Geocode a single travel activity using Google Places API. Updates the activity with place_id, lat, lng.",
  {
    activityId: z.string().describe("The travel activity record ID"),
    searchQuery: z.string().optional().describe("Custom search query (default: activity name + location)"),
  },
  async ({ activityId, searchQuery }) => {
    const body: Record<string, unknown> = {};
    if (searchQuery) body.searchQuery = searchQuery;
    const data = await api(`/travel/activities/${activityId}/geocode`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "geocode_trip_activities",
  "Batch geocode all un-geocoded activities for a trip. Returns progress summary.",
  {
    tripId: z.string().describe("The travel trip record ID"),
  },
  async ({ tripId }) => {
    // First get the trip to find the log ID
    const trip = (await api(`/travel/trips/${tripId}`)) as { log: string; destination: string };
    const data = await api("/travel/activities/batch-geocode", {
      method: "POST",
      body: JSON.stringify({ log: trip.log, trip_id: tripId }),
    });
    const result = data as { total: number; geocoded: number; skipped: number; errors: number; details: Array<{ id: string; name: string; status: string; error?: string }> };
    // Build a human-friendly summary
    const lines = [`Batch geocode for trip "${trip.destination}":`, `  Total: ${result.total}, Geocoded: ${result.geocoded}, Skipped: ${result.skipped}, Errors: ${result.errors}`];
    for (const d of result.details || []) {
      const suffix = d.error ? ` — ${d.error}` : "";
      lines.push(`  ${d.status}: ${d.name}${suffix}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// --- Sharing tools ---

server.tool(
  "create_invite",
  "Create a sharing invite link for a recipe box, recipe, or travel log",
  {
    targetType: z.enum(["box", "recipe", "travel_log"]).describe("Type of resource to share"),
    targetId: z.string().describe("ID of the box, recipe, or travel log to share"),
  },
  async ({ targetType, targetId }) => {
    const data = await apiRaw("/sharing/invite", {
      method: "POST",
      body: JSON.stringify({ targetType, targetId }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Homelab MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
