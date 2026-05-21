/**
 * MCP server exposing homelab recipe, shopping, and upkeep data as tools.
 * Calls the HTTP API internally so it goes through the same auth and business logic.
 *
 * Run with: pnpm mcp
 */
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { API_BASE } from "./config";
import {
  validateDay,
  type DayIssue,
  type ValidationActivity,
  type ValidationSlot,
} from "@homelab/backend";

/**
 * Normalize a snake_case Activity from the `/travel/activities` API endpoint
 * into the camelCase `ValidationActivity` shape the canonical validator expects.
 * The API response uses snake_case (`duration_estimate`); the validator is
 * camelCase end-to-end.
 */
function toValidationActivity(a: Record<string, unknown>): ValidationActivity {
  return {
    id: a.id as string,
    name: (a.name as string | undefined) ?? "",
    lat: (a.lat as number | null | undefined) ?? null,
    lng: (a.lng as number | null | undefined) ?? null,
    durationEstimate: (a.duration_estimate as string | undefined) ?? undefined,
  };
}

/**
 * Translate a canonical `DayIssue` (camelCase `slotIndices`) into the
 * snake_case wire format used by MCP JSON responses (`slot_indices`).
 */
function toWireIssue(issue: DayIssue): {
  kind: DayIssue["kind"];
  message: string;
  slot_indices: [number, number];
} {
  return {
    kind: issue.kind,
    message: issue.message,
    slot_indices: issue.slotIndices,
  };
}

// Builds a configured MCP server bound to a specific API token. Inner closures
// capture `apiToken`, so each caller (stdio bootstrap, per-request HTTP handler)
// gets its own server scoped to the right user identity. The body is left at
// module-level indentation to keep this refactor a thin wrapper, not a rewrite.
export function buildMcpServer(apiToken: string): McpServer {

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${API_BASE}/data${path}`;
  return apiFetch(url, init);
}

/** Call a non-data route (e.g. /recipes/scrape, /ai/enrich, /sharing/invite) */
async function apiRaw(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  return apiFetch(url, init);
}

async function apiFetch(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${apiToken}`,
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

server.tool(
  "update_shopping_item",
  "Update fields on a shopping item (note, category, ingredient name, or checked state)",
  {
    id: z.string().describe("The shopping item ID"),
    ingredient: z.string().optional(),
    note: z.string().optional(),
    category_id: z.string().optional(),
    checked: z.boolean().optional(),
  },
  async ({ id, ...body }) => {
    const data = await api(`/shopping/items/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "create_shopping_list",
  "Create a new shopping list. Adds the list to the authenticated user's shopping_slugs map.",
  {
    name: z.string().describe("Display name of the list"),
    slug: z.string().optional().describe("URL slug (auto-derived from name if omitted)"),
  },
  async ({ name, slug }) => {
    const data = await api("/shopping/lists", {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_shopping_list",
  "Rename a shopping list or change its slug",
  {
    id: z.string().describe("The shopping list ID"),
    name: z.string().optional(),
    slug: z.string().optional(),
  },
  async ({ id, ...body }) => {
    const data = await api(`/shopping/lists/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "delete_shopping_list",
  "Delete a shopping list. WARNING: cascades to all items in the list.",
  { id: z.string().describe("The shopping list ID") },
  async ({ id }) => {
    const data = await api(`/shopping/lists/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Upkeep tools ---

server.tool(
  "list_task_lists",
  "List all task lists owned by the authenticated user. Call this first to discover list IDs before using list_tasks. Recurring tasks (litter box, watering plants, etc.) live inside one of these.",
  {},
  async () => {
    const data = await api("/task-lists");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

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
  "List travel trips (summary view — use get_travel_trip for full details). Optionally filter by status. Each trip includes an `issue_count` summary across all its itineraries; drill into `get_trip_issues` or `get_travel_trip` for the per-day breakdown.",
  {
    status: z.string().optional().describe("Filter by status: Completed, Booked, Researching, Idea, Ongoing"),
  },
  async ({ status }) => {
    const logs = (await api("/travel/logs")) as Array<{ id: string; slug: string; name: string }>;
    const allTrips: Array<Record<string, unknown>> = [];
    for (const log of logs) {
      const qs = status ? `&status=${encodeURIComponent(status)}` : "";
      const trips = (await api(`/travel/trips?log=${log.id}${qs}`)) as Array<Record<string, unknown>>;
      // For each trip in this log, sum issue counts across all itinerary days.
      // N+1 in trip count: fine for single-digit active trips, premature to optimize.
      const enriched = await Promise.all(trips.map(async (t) => {
        const tripId = t.id as string;
        const [activities, itineraries] = await Promise.all([
          api(`/travel/activities?log=${log.id}&trip_id=${tripId}`) as Promise<Array<Record<string, unknown>>>,
          api(`/travel/itineraries?log=${log.id}&trip_id=${tripId}`) as Promise<Array<{ days?: Array<{ slots?: ValidationSlot[] }> }>>,
        ]);
        const activityMap = new Map<string, ValidationActivity>(
          activities.map((a) => [a.id as string, toValidationActivity(a)]),
        );
        let issueCount = 0;
        for (const itin of itineraries) {
          for (const day of itin.days ?? []) {
            issueCount += validateDay(day.slots ?? [], activityMap).length;
          }
        }
        return { ...t, logName: log.name, issue_count: issueCount };
      }));
      allTrips.push(...enriched);
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
  "Get full details for a single trip including notes, activities, and itineraries. Each itinerary day is annotated with `issue_count` (and `issues[]` when nonzero) — overlap/out-of-order/drive-gap planning conflicts. Address these before considering the day's schedule final.",
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
    // Annotate each day with validation results.
    const activityMap = new Map<string, ValidationActivity>(
      tripActivities.map((a) => [a.id as string, toValidationActivity(a)]),
    );
    const enrichedItineraries = tripItineraries.map((itin) => {
      const days = (itin.days as Array<Record<string, unknown>> | undefined) ?? [];
      const annotatedDays = days.map((day) => {
        const slots = (day.slots as ValidationSlot[] | undefined) ?? [];
        const issues = validateDay(slots, activityMap);
        return {
          ...day,
          issue_count: issues.length,
          ...(issues.length > 0 ? { issues: issues.map(toWireIssue) } : {}),
        };
      });
      return { ...itin, days: annotatedDays };
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ...trip, activities: tripActivities, itineraries: enrichedItineraries }, null, 2),
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

server.tool(
  "get_trip_issues",
  "Validate a trip's itineraries and return per-day issues (overlap, out-of-order, drive-gap). Mirrors what the travel app shows as 'N issues' on each day. Use this — and the inline issue_count fields on get_travel_trip / list_travel_trips — to spot planning conflicts before treating an itinerary as final.",
  { trip_id: z.string().describe("The travel trip record ID") },
  async ({ trip_id }) => {
    const trip = (await api(`/travel/trips/${trip_id}`)) as Record<string, unknown>;
    const logId = trip.log as string;
    const destination = trip.destination as string;
    const [activities, itineraries] = await Promise.all([
      api(`/travel/activities?log=${logId}&trip_id=${trip_id}`) as Promise<Array<Record<string, unknown>>>,
      api(`/travel/itineraries?log=${logId}&trip_id=${trip_id}`) as Promise<Array<{
        id: string;
        name: string;
        is_active: boolean;
        days?: Array<{ date?: string; label?: string; slots?: ValidationSlot[] }>;
      }>>,
    ]);
    const activityMap = new Map<string, ValidationActivity>(
      activities.map((a) => [a.id as string, toValidationActivity(a)]),
    );
    const itinSummaries = itineraries.map((itin) => {
      const days = (itin.days ?? []).map((day, dayIndex) => {
        const issues = validateDay(day.slots ?? [], activityMap);
        return {
          day_index: dayIndex,
          date: day.date,
          label: day.label,
          issue_count: issues.length,
          ...(issues.length > 0 ? { issues: issues.map(toWireIssue) } : {}),
        };
      });
      return {
        id: itin.id,
        name: itin.name,
        is_active: itin.is_active,
        days,
      };
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ trip_id, destination, itineraries: itinSummaries }, null, 2),
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
    const log = (await api("/life/log")) as { id: string; name: string };
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

server.tool(
  "add_life_entry",
  "Record a life log entry. Each entry tracks one widget (subject_id) at a point in time. Data shape depends on widget type (e.g. {checked: true}, {value: 5}, {rating: 3}).",
  {
    log: z.string().describe("The life log ID"),
    widget_id: z.string().describe("The widget ID this entry is for (subject_id in PB)"),
    data: z.record(z.unknown()).optional().describe("Widget-specific payload (defaults to {})"),
    timestamp: z.string().optional().describe("ISO timestamp (defaults to now)"),
    notes: z.string().optional().describe("Free-form notes — merged into data.notes"),
  },
  async ({ log, widget_id, data, timestamp, notes }) => {
    const result = await api("/life/entries", {
      method: "POST",
      body: JSON.stringify({ log, widget_id, data, timestamp, notes }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "update_life_entry",
  "Update a life log entry — change timestamp, merge new data, or set notes",
  {
    id: z.string().describe("The life entry ID"),
    timestamp: z.string().optional().describe("New ISO timestamp"),
    data: z.record(z.unknown()).optional().describe("Fields to merge into existing data"),
    notes: z.string().optional().describe("Set/replace notes (empty string clears)"),
  },
  async ({ id, ...body }) => {
    const result = await api(`/life/entries/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "delete_life_entry",
  "Delete a life log entry",
  { id: z.string().describe("The life entry ID") },
  async ({ id }) => {
    const result = await api(`/life/entries/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

// Recipe data follows schema.org Recipe shape. Explicit fields cover what the
// webapp edits; .passthrough() keeps any extra schema.org fields (image,
// datePublished, recipeCuisine, totalTime, nutrition, keywords, …) intact.
const recipeAuthorSchema = z.union([
  z.object({ "@type": z.literal("Person").optional(), name: z.string() }).passthrough(),
  z.array(z.object({ "@type": z.literal("Person").optional(), name: z.string() }).passthrough()),
  z.string(),
]);

const recipeDataSchema = z.object({
  "@type": z.literal("Recipe").optional().describe("Schema.org type marker — usually \"Recipe\""),
  name: z.string().optional().describe("Recipe name"),
  description: z.string().optional().describe("Short summary of the recipe"),
  url: z.string().optional().describe("Source URL (for scraped recipes)"),
  author: recipeAuthorSchema.optional().describe("Recipe author. Object form: {\"@type\":\"Person\",\"name\":\"Julia Child\"}"),
  recipeIngredient: z.array(z.string()).optional().describe("List of ingredient strings, e.g. [\"2 cups flour\", \"1 tsp salt\"]"),
  recipeInstructions: z.array(z.object({
    "@type": z.literal("HowToStep").optional(),
    text: z.string().describe("Instruction text for this step"),
    ingredients: z.array(z.string()).optional().describe("Ingredients used in this specific step (optional)"),
  })).optional().describe("Ordered list of instruction steps"),
  recipeCategory: z.array(z.string()).optional().describe("Tags/categories, e.g. [\"dessert\", \"quick\"]"),
  recipeYield: z.string().optional().describe("Servings/yield, e.g. \"4 servings\" or \"12 cookies\""),
  prepTime: z.string().optional().describe("Prep duration in ISO 8601 format, e.g. \"PT15M\""),
  cookTime: z.string().optional().describe("Cook duration in ISO 8601 format, e.g. \"PT45M\""),
  totalTime: z.string().optional().describe("Total duration in ISO 8601 format, e.g. \"PT1H\""),
  recipeCuisine: z.string().optional().describe("Cuisine type, e.g. \"Italian\""),
  comment: z.object({
    "@type": z.literal("Comment").optional(),
    text: z.string(),
  }).passthrough().optional().describe("Recipe notes. THIS is the field the webapp's 'Notes' panel reads and writes — pass {\"@type\":\"Comment\",\"text\":\"...\"}. Do not put notes anywhere else."),
}).passthrough();

server.tool(
  "add_recipe_to_box",
  "Create a recipe in a recipe box. Recipe data follows schema.org Recipe shape; pass any sensible fields (extra fields beyond the explicit ones are preserved).",
  {
    boxId: z.string().describe("The recipe box ID"),
    data: recipeDataSchema.describe("Recipe data object"),
  },
  async ({ boxId, data }) => {
    const result = await api("/recipes", {
      method: "POST",
      body: JSON.stringify({ boxId, data }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "update_recipe",
  "Update a recipe's structured data. Replaces the entire data object — pass the full recipe (use get_recipe first to fetch current data, modify, and pass back). Clears any pending AI enrichment changes.",
  {
    id: z.string().describe("The recipe record ID"),
    data: recipeDataSchema.describe("Full recipe data object — replaces existing data"),
  },
  async ({ id, data }) => {
    const result = await api(`/recipes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ data }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// --- Surgical recipe.data ops ---
// Prefer these over update_recipe (whole-replace) for single-field edits,
// ingredient/step swaps, and step reorders. They invalidate enrichment
// the same way the whole-replace does.

server.tool(
  "patch_recipe",
  "Merge top-level fields into recipe.data (name, description, recipeYield, recipeCuisine, etc). Pass null to clear a field. For ingredient/step arrays prefer the dedicated surgical ops.",
  {
    id: z.string().describe("The recipe record ID"),
    fields: z.record(z.unknown()).describe("Partial recipeDataSchema fields to merge; null to clear"),
  },
  async ({ id, fields }) => {
    const result = await api(`/recipes/${id}/data`, {
      method: "PATCH",
      body: JSON.stringify({ fields }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "add_recipe_ingredient",
  "Append (or insert at position) an ingredient on a recipe. Position defaults to end.",
  {
    id: z.string().describe("The recipe record ID"),
    ingredient: z.string().describe('The ingredient string, e.g. "1 tsp kosher salt"'),
    position: z.number().int().nonnegative().optional(),
  },
  async ({ id, ingredient, position }) => {
    const result = await api(`/recipes/${id}/ingredients`, {
      method: "POST",
      body: JSON.stringify({ ingredient, position }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "update_recipe_ingredient",
  "Replace a single ingredient by index.",
  {
    id: z.string().describe("The recipe record ID"),
    index: z.number().int().nonnegative(),
    ingredient: z.string(),
  },
  async ({ id, index, ingredient }) => {
    const result = await api(`/recipes/${id}/ingredients/${index}`, {
      method: "PATCH",
      body: JSON.stringify({ ingredient }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "remove_recipe_ingredient",
  "Remove an ingredient by index.",
  {
    id: z.string().describe("The recipe record ID"),
    index: z.number().int().nonnegative(),
  },
  async ({ id, index }) => {
    const result = await api(`/recipes/${id}/ingredients/${index}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "reorder_recipe_ingredients",
  "Reorder ingredients via a permutation. order[i] = old index that should land at new position i. Must be a complete permutation of [0..n-1].",
  {
    id: z.string().describe("The recipe record ID"),
    order: z.array(z.number().int().nonnegative()).describe("Permutation of indices"),
  },
  async ({ id, order }) => {
    const result = await api(`/recipes/${id}/ingredients/reorder`, {
      method: "POST",
      body: JSON.stringify({ order }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "add_recipe_step",
  "Append (or insert at position) an instruction step on a recipe. The step takes free-form text and an optional ingredients list (subset of the recipe's recipeIngredient strings used in this step).",
  {
    id: z.string().describe("The recipe record ID"),
    text: z.string().describe("Instruction text"),
    ingredients: z.array(z.string()).optional().describe("Ingredients used in this step"),
    position: z.number().int().nonnegative().optional(),
  },
  async ({ id, ...body }) => {
    const result = await api(`/recipes/${id}/steps`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "update_recipe_step",
  "Patch a single step. text/ingredients are independently optional. Pass ingredients=null to clear the per-step ingredients field.",
  {
    id: z.string().describe("The recipe record ID"),
    index: z.number().int().nonnegative(),
    text: z.string().optional(),
    ingredients: z.array(z.string()).nullable().optional(),
  },
  async ({ id, index, ...body }) => {
    const result = await api(`/recipes/${id}/steps/${index}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "remove_recipe_step",
  "Remove an instruction step by index.",
  {
    id: z.string().describe("The recipe record ID"),
    index: z.number().int().nonnegative(),
  },
  async ({ id, index }) => {
    const result = await api(`/recipes/${id}/steps/${index}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "reorder_recipe_steps",
  "Reorder steps via a permutation. Same contract as reorder_recipe_ingredients.",
  {
    id: z.string().describe("The recipe record ID"),
    order: z.array(z.number().int().nonnegative()),
  },
  async ({ id, order }) => {
    const result = await api(`/recipes/${id}/steps/reorder`, {
      method: "POST",
      body: JSON.stringify({ order }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "delete_recipe",
  "Permanently delete a recipe and its cooking log entries",
  { id: z.string().describe("The recipe record ID") },
  async ({ id }) => {
    const result = await api(`/recipes/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "set_recipe_visibility",
  "Set a recipe's visibility (private, public, or unlisted)",
  {
    id: z.string().describe("The recipe record ID"),
    visibility: z.enum(["private", "public", "unlisted"]),
  },
  async ({ id, visibility }) => {
    const result = await api(`/recipes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ visibility }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "update_recipe_box",
  "Update a recipe box's name, description, or visibility",
  {
    id: z.string().describe("The recipe box record ID"),
    name: z.string().optional(),
    description: z.string().optional(),
    visibility: z.enum(["private", "public", "unlisted"]).optional(),
  },
  async ({ id, ...body }) => {
    const result = await api(`/boxes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "delete_recipe_box",
  "Permanently delete a recipe box. WARNING: cascades to all recipes and cooking log entries in the box.",
  { id: z.string().describe("The recipe box record ID") },
  async ({ id }) => {
    const result = await api(`/boxes/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "subscribe_to_box",
  "Subscribe the authenticated user to a recipe box (adds it to their box list)",
  { boxId: z.string().describe("The recipe box record ID") },
  async ({ boxId }) => {
    const result = await api(`/boxes/${boxId}/subscribe`, { method: "POST" });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "unsubscribe_from_box",
  "Unsubscribe the authenticated user from a recipe box",
  { boxId: z.string().describe("The recipe box record ID") },
  async ({ boxId }) => {
    const result = await api(`/boxes/${boxId}/unsubscribe`, { method: "POST" });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "list_cooking_log",
  "List cooking log entries (notes, timestamps) for a recipe, newest first",
  { recipeId: z.string().describe("The recipe record ID") },
  async ({ recipeId }) => {
    const result = await api(`/recipes/${recipeId}/cooking-log`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "add_cooking_log_entry",
  "Record that a recipe was cooked, optionally with notes. Defaults timestamp to now.",
  {
    recipeId: z.string().describe("The recipe record ID"),
    notes: z.string().optional().describe("Optional notes about this cooking session"),
    timestamp: z.string().optional().describe("ISO timestamp (defaults to now)"),
  },
  async ({ recipeId, notes, timestamp }) => {
    const result = await api(`/recipes/${recipeId}/cooking-log`, {
      method: "POST",
      body: JSON.stringify({ notes, timestamp }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "update_cooking_log_entry",
  "Edit notes and/or timestamp on a cooking log entry. Pass empty-string notes to clear; pass timestamp to fix a wrong-day entry.",
  {
    eventId: z.string().describe("The cooking log event ID"),
    notes: z.string().optional(),
    timestamp: z.string().optional().describe("ISO datetime to overwrite when the recipe was cooked"),
  },
  async ({ eventId, ...body }) => {
    const result = await api(`/cooking-log/${eventId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "delete_cooking_log_entry",
  "Delete a cooking log entry",
  { eventId: z.string().describe("The cooking log event ID") },
  async ({ eventId }) => {
    const result = await api(`/cooking-log/${eventId}`, { method: "DELETE" });
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

const flightInfoSchema = z.object({
  airline: z.string().optional().describe("Airline code or name (e.g. 'UA', 'United')"),
  number: z.string().optional().describe("Flight number (e.g. '1234')"),
  from: z.string().optional().describe("Departure airport code (e.g. 'SFO')"),
  to: z.string().optional().describe("Arrival airport code (e.g. 'JFK')"),
  fromLat: z.number().optional().describe("Departure airport latitude"),
  fromLng: z.number().optional().describe("Departure airport longitude"),
  toLat: z.number().optional().describe("Arrival airport latitude"),
  toLng: z.number().optional().describe("Arrival airport longitude"),
  departsAt: z.string().optional().describe("Departure ISO datetime"),
  arrivesAt: z.string().optional().describe("Arrival ISO datetime"),
  fromIsHome: z.boolean().optional().describe("Departure is the user's home airport (hides flight from itinerary map)"),
  toIsHome: z.boolean().optional().describe("Arrival is the user's home airport (hides flight from itinerary map)"),
}).describe("Structured flight data (category='Flight'). Use geocode_activity to auto-fill coords from airport codes.");

// Activity field set covers everything the route accepts. add_/update_ share
// the same fields so callers get a consistent surface; only `id` vs `log+name`
// requirements differ.
const activityFields = {
  name: z.string().optional().describe("Activity name"),
  category: z.string().optional().describe("Activity category (Flight, Transportation, Accommodation, Hiking, etc.)"),
  location: z.string().optional().describe("Location (e.g. 'Phoenix, AZ')"),
  description: z.string().optional().describe("Brief qualifying note. NOT costs/durations/logistics, and NOT booking instructions — put advance-booking needs in `booking_reqs` so the readiness dashboard can track them."),
  cost_notes: z.string().optional().describe("Cost notes (e.g. '$25/person')"),
  duration_estimate: z.string().optional().describe("Duration (e.g. '2h', 'half day')"),
  walk_miles: z.number().optional().describe("Distance walked or hiked in miles (e.g. trail length)"),
  elevation_gain_feet: z.number().optional().describe("Elevation gain in feet (Hiking activities)"),
  difficulty: z.enum(["easy", "moderate", "hard", "strenuous", ""]).optional().describe("Hike difficulty rating"),
  setting: z.enum(["outdoor", "indoor", "either"]).optional(),
  trip_id: z.string().optional().describe("Trip this activity belongs to"),
  confirmation_code: z.string().optional().describe("Booking confirmation code — set this once the booking is done; the readiness dashboard treats it as the 'confirmed' signal."),
  details: z.string().optional().describe("Freeform details text"),
  flight_info: flightInfoSchema.optional(),
  booking_reqs: z.array(z.object({
    action: z.string().describe("What to do, e.g. 'Book tickets at museofridakahlo.org.mx'"),
    daysBefore: z.number().describe("How many days before trip start the action is due"),
    done: z.boolean().optional().describe("Mark true once the action is complete"),
  })).optional().describe("Structured advance-booking requirements. The readiness dashboard surfaces these by deadline; populate this (not the description) whenever an activity requires reservations/permits/timed entry/etc."),
  verdict: z.enum(["loved", "liked", "meh", "skip", ""]).optional().describe("Post-experience reflection"),
  personal_notes: z.string().optional().describe("Private notes about this activity (post-trip journal)"),
  experienced_at: z.string().optional().describe("ISO date when the activity was actually done"),
};

server.tool(
  "get_travel_activity",
  "Get full details for a single travel activity, including geocoding (lat/lng/place_id), flight info, verdict/notes, and all metadata fields.",
  { id: z.string().describe("The activity record ID") },
  async ({ id }) => {
    const data = await api(`/travel/activities/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "add_travel_activity",
  "Create a new activity in a travel log. For flights, use category='Flight' and include flight_info.",
  {
    log: z.string().describe("The travel log ID"),
    ...activityFields,
    name: z.string().describe("Activity name (required for create)"),
  },
  async ({ log, ...fields }) => {
    const body: Record<string, unknown> = { log };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) body[k] = v;
    }
    const data = await api("/travel/activities", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_travel_activity",
  "Update fields on an existing travel activity. Only provided fields change. Use for post-trip reflection (verdict/personal_notes/experienced_at) too.",
  {
    id: z.string().describe("The activity record ID"),
    ...activityFields,
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

// --- Itinerary surgical patch tools ---
// Each operates on (itinerary_id, day_index, [slot_index]) and mutates only
// that locality on the server, so callers don't need to round-trip the entire
// days array for a small change. Prefer these over update_travel_itinerary
// when adjusting individual slots.

server.tool(
  "add_itinerary_slot",
  "Add an activity slot to a specific day in an itinerary. Position defaults to end of the day.",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    day_index: z.number().int().nonnegative().describe("0-based index of the day"),
    activity_id: z.string().describe("The activity record ID to slot in"),
    start_time: z.string().optional().describe("Time of day (e.g. '9:00 AM')"),
    notes: z.string().optional().describe("Slot-specific notes"),
    position: z.number().int().nonnegative().optional().describe("0-based insertion position; defaults to end"),
  },
  async ({ itinerary_id, day_index, ...body }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days/${day_index}/slots`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "remove_itinerary_slot",
  "Remove a slot from a day in an itinerary by index.",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    day_index: z.number().int().nonnegative(),
    slot_index: z.number().int().nonnegative().describe("0-based slot index within the day"),
  },
  async ({ itinerary_id, day_index, slot_index }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days/${day_index}/slots/${slot_index}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_itinerary_slot",
  "Update fields on a single slot (start_time, notes, or activity_id). Pass null to clear an optional field.",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    day_index: z.number().int().nonnegative(),
    slot_index: z.number().int().nonnegative(),
    activity_id: z.string().optional().describe("Replace the activity reference"),
    start_time: z.string().nullable().optional().describe("Time of day, or null to clear"),
    notes: z.string().nullable().optional().describe("Slot notes, or null to clear"),
  },
  async ({ itinerary_id, day_index, slot_index, ...body }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days/${day_index}/slots/${slot_index}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "move_itinerary_slot",
  "Move a slot to a different position within the same day, or transfer it to a different day.",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    day_index: z.number().int().nonnegative().describe("Source day index"),
    slot_index: z.number().int().nonnegative().describe("Source slot index"),
    to_day_index: z.number().int().nonnegative().describe("Target day index (can be same as source)"),
    to_position: z.number().int().nonnegative().optional().describe("Target position; defaults to end of target day"),
  },
  async ({ itinerary_id, day_index, slot_index, ...body }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days/${day_index}/slots/${slot_index}/move`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_itinerary_day",
  "Update a day's metadata (label, date, lodging). Pass null to clear date or lodging.",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    day_index: z.number().int().nonnegative(),
    label: z.string().optional().describe("Day label, e.g. 'Day 2 — Sedona'"),
    date: z.string().nullable().optional().describe("ISO date for completed/scheduled days, or null to clear"),
    lodging_activity_id: z.string().nullable().optional().describe("Activity ID for that night's lodging, or null to clear"),
  },
  async ({ itinerary_id, day_index, ...body }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days/${day_index}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "add_itinerary_day",
  "Insert a new day into an itinerary at the given position (default: end).",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    label: z.string().describe("Day label, e.g. 'Day 4 — Rest day'"),
    date: z.string().optional().describe("ISO date if scheduled"),
    lodging_activity_id: z.string().optional().describe("Activity ID for lodging on this night"),
    position: z.number().int().nonnegative().optional().describe("Insertion position; defaults to end"),
  },
  async ({ itinerary_id, ...body }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "remove_itinerary_day",
  "Remove a day from an itinerary by index. Cascades any slots/flights it contained — those activity records still exist on the trip but become unscheduled.",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    day_index: z.number().int().nonnegative(),
  },
  async ({ itinerary_id, day_index }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days/${day_index}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "move_itinerary_day",
  "Reorder a whole day in an itinerary (e.g., move Day 5 to Day 3).",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    day_index: z.number().int().nonnegative().describe("Source day index"),
    to_position: z.number().int().nonnegative().describe("New position for this day"),
  },
  async ({ itinerary_id, day_index, to_position }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days/${day_index}/move`, {
      method: "POST",
      body: JSON.stringify({ to_position }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Itinerary flight-slot ops (parity with regular slot ops) ---
// Days have a separate `flights[]` for major transport. Same shape and
// semantics as add/remove/update/move_itinerary_slot.

server.tool(
  "add_itinerary_flight",
  "Add a flight (or other major-transport) slot to a day's flights array. Position defaults to end.",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    day_index: z.number().int().nonnegative(),
    activity_id: z.string().describe("The Flight-category activity to slot in"),
    start_time: z.string().optional(),
    notes: z.string().optional(),
    position: z.number().int().nonnegative().optional(),
  },
  async ({ itinerary_id, day_index, ...body }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days/${day_index}/flights`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "remove_itinerary_flight",
  "Remove a flight from a day's flights array by index.",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    day_index: z.number().int().nonnegative(),
    flight_index: z.number().int().nonnegative(),
  },
  async ({ itinerary_id, day_index, flight_index }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days/${day_index}/flights/${flight_index}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_itinerary_flight",
  "Update fields on a single flight slot (start_time, notes, activity_id). Pass null to clear an optional field.",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    day_index: z.number().int().nonnegative(),
    flight_index: z.number().int().nonnegative(),
    activity_id: z.string().optional(),
    start_time: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  },
  async ({ itinerary_id, day_index, flight_index, ...body }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days/${day_index}/flights/${flight_index}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "move_itinerary_flight",
  "Reorder a flight within a day, or move it to a different day.",
  {
    itinerary_id: z.string().describe("The itinerary record ID"),
    day_index: z.number().int().nonnegative().describe("Source day index"),
    flight_index: z.number().int().nonnegative().describe("Source flight index"),
    to_day_index: z.number().int().nonnegative(),
    to_position: z.number().int().nonnegative().optional(),
  },
  async ({ itinerary_id, day_index, flight_index, ...body }) => {
    const data = await api(`/travel/itineraries/${itinerary_id}/days/${day_index}/flights/${flight_index}/move`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Upkeep write tools ---

const taskFrequencySchema = z.object({
  value: z.number(),
  unit: z.enum(["days", "weeks", "months"]),
});

server.tool(
  "add_task",
  "Create a task. Supports nesting (parent_id), task types (recurring/one_shot), tags, and notification subscribers. For trip-prep tasks, prefer add_trip_task — it handles the Trips/<destination>/ container nesting that this tool doesn't.",
  {
    list: z.string().describe("The task list ID"),
    name: z.string().describe("Task name"),
    description: z.string().optional().describe("Task description"),
    parent_id: z.string().optional().describe("Parent task ID for nesting (omit for root task)"),
    position: z.number().optional().describe("Sort position among siblings (default 0)"),
    task_type: z.enum(["recurring", "one_shot"]).optional().describe("'recurring' (has frequency/due dates) or 'one_shot' (checkbox). Default: one_shot"),
    frequency: taskFrequencySchema.optional().describe("Recurrence frequency (only for recurring tasks)"),
    tags: z.array(z.string()).optional().describe("Tags (e.g. ['travel:tripId123'])"),
    notify_users: z.array(z.string()).optional().describe("User IDs to notify on completion/due"),
  },
  async ({ list, name, description, parent_id, position, task_type, frequency, tags, notify_users }) => {
    const data = await api("/tasks", {
      method: "POST",
      body: JSON.stringify({ list, name, description, parent_id, position, task_type, frequency, tags, notify_users }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// Canonical way to add a trip-prep task. Hides the Trips/<destination>/ container
// orchestration that TripChecklist.tsx does in the UI (ensureTripContainer + handleAdd).
// All defaults — task_type "one_shot", frequency { value: 1, unit: "days" }, completed
// false, snoozed null, collapsed false — match exactly what the UI writes so MCP-created
// trip tasks are indistinguishable from UI-created ones. Edit the resulting task later
// with tag_task / update_task.
server.tool(
  "add_trip_task",
  "Add a trip-prep task to a trip's checklist. This is the canonical way to add tasks tied to a travel trip: it automatically nests the new task under Trips/<destination>/ (creating those container tasks on demand) and tags it with travel:<trip_id>, matching the Travel app's checklist UI. Use this instead of raw add_task whenever the task is associated with a trip — raw add_task does not create the container hierarchy and would leave the task as a top-level outliner item. Edit the resulting task later with tag_task / update_task.",
  {
    trip_id: z.string().describe("The travel trip record ID this task belongs to"),
    name: z.string().describe("Task name (the user-facing prep item, e.g. 'Pack adapters')"),
    description: z.string().optional().describe("Optional task description"),
    list_id: z.string().optional().describe("Task list to add into. Defaults to the caller's first household task list (matching the Travel UI's behavior)."),
    position: z.number().optional().describe("Sort position among siblings under the per-trip container. Defaults to max-sibling-position + 1."),
    notify_users: z.array(z.string()).optional().describe("User IDs to notify on completion/due"),
  },
  async ({ trip_id, name, description, list_id, position, notify_users }) => {
    // 1. Resolve list. If none given, fall back to the first task list owned by the
    // caller. The Travel UI uses user.household_slugs (first entry), but no API
    // endpoint exposes that map — /data/task-lists already filters to lists the
    // caller owns, so the first entry is a faithful server-side equivalent in
    // practice (household_slugs is the only namespace that registers task lists).
    let resolvedListId = list_id;
    if (!resolvedListId) {
      const lists = (await api("/task-lists")) as Array<{ id: string; name: string }>;
      if (!lists.length) {
        throw new Error("No task list found for caller. Create one in the Tasks app first, or pass list_id explicitly.");
      }
      resolvedListId = lists[0].id;
    }

    // 2. Fetch the trip for its destination (used as per-trip container name).
    const trip = (await api(`/travel/trips/${trip_id}`)) as { id: string; destination: string };
    const tripContainerTag = `container:trip:${trip_id}`;
    const tripTag = `travel:${trip_id}`;

    type TaskLite = { id: string; name: string; parent_id: string; position: number; tags?: string[] };

    // Helper: list tasks under a parent (used to find containers + compute next position).
    const listChildren = async (parentId: string): Promise<TaskLite[]> => {
      const params = new URLSearchParams({ list: resolvedListId!, parent_id: parentId });
      return (await api(`/tasks?${params}`)) as TaskLite[];
    };
    // Race-tolerant find: pick the first match by id sort so concurrent creates
    // resolve to a single canonical container instead of one caller seeing the
    // other's duplicate. (UI has the same race; not solving it server-side, just
    // making the resolution deterministic.)
    const pickFirst = (matches: TaskLite[]): TaskLite | undefined =>
      matches.sort((a, b) => a.id.localeCompare(b.id))[0];

    const maxPos = (siblings: TaskLite[]): number =>
      siblings.reduce((m, t) => Math.max(m, t.position), 0);

    // 3. Find or create the "Trips" root container (parent_id = "", tag container:trips).
    const rootTasks = await listChildren("");
    let tripsRoot = pickFirst(rootTasks.filter((t) => t.tags?.includes("container:trips")));
    if (!tripsRoot) {
      const created = (await api("/tasks", {
        method: "POST",
        body: JSON.stringify({
          list: resolvedListId,
          parent_id: "",
          position: maxPos(rootTasks) + 1,
          name: "Trips",
          description: "",
          task_type: "one_shot",
          frequency: { value: 1, unit: "days" },
          tags: ["container:trips"],
        }),
      })) as { id: string; name: string };
      tripsRoot = { id: created.id, name: created.name, parent_id: "", position: maxPos(rootTasks) + 1, tags: ["container:trips"] };
    }

    // 4. Find or create the per-trip container (parent = tripsRoot, tag container:trip:<id>).
    const tripsChildren = await listChildren(tripsRoot.id);
    let tripContainer = pickFirst(tripsChildren.filter((t) => t.tags?.includes(tripContainerTag)));
    if (!tripContainer) {
      const created = (await api("/tasks", {
        method: "POST",
        body: JSON.stringify({
          list: resolvedListId,
          parent_id: tripsRoot.id,
          position: maxPos(tripsChildren) + 1,
          name: trip.destination,
          description: "",
          task_type: "one_shot",
          frequency: { value: 1, unit: "days" },
          tags: [tripContainerTag],
        }),
      })) as { id: string; name: string };
      tripContainer = { id: created.id, name: created.name, parent_id: tripsRoot.id, position: maxPos(tripsChildren) + 1, tags: [tripContainerTag] };
    }

    // 5. Create the actual leaf task, tagged travel:<trip_id>.
    const leafSiblings = await listChildren(tripContainer.id);
    const leafPosition = position ?? maxPos(leafSiblings) + 1;
    const data = await api("/tasks", {
      method: "POST",
      body: JSON.stringify({
        list: resolvedListId,
        parent_id: tripContainer.id,
        position: leafPosition,
        name,
        description: description ?? "",
        task_type: "one_shot",
        frequency: { value: 1, unit: "days" },
        tags: [tripTag],
        notify_users,
      }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_task",
  "Update fields on an existing task. Only provided fields are changed. To reparent or move between lists, use move_task — direct parent_id changes are not allowed here because they would leave descendant paths stale.",
  {
    id: z.string().describe("The task record ID"),
    name: z.string().optional(),
    description: z.string().optional(),
    position: z.number().optional(),
    task_type: z.enum(["recurring", "one_shot"]).optional(),
    frequency: taskFrequencySchema.optional(),
    completed: z.boolean().optional().describe("One-shot tasks only — for recurring use complete_task instead"),
    snoozed_until: z.string().optional().describe("ISO date — empty string clears snooze"),
    tags: z.array(z.string()).optional().describe("Replaces the tag list. For partial edits use tag_task once available."),
    notify_users: z.array(z.string()).optional(),
    collapsed: z.boolean().optional(),
  },
  async ({ id, ...body }) => {
    const data = await api(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "move_task",
  "Move a task: change its parent (within or across lists), and/or its position among siblings. Recomputes path on the task and all descendants atomically. Pass new_parent_id='' to make it a root task.",
  {
    id: z.string().describe("The task record ID"),
    new_parent_id: z.string().nullable().optional().describe("New parent task ID, '' (root), or omit to keep parent"),
    new_list: z.string().optional().describe("Target task list ID (must contain the new parent if any)"),
    position: z.number().optional().describe("New position among siblings"),
  },
  async ({ id, ...body }) => {
    const data = await api(`/tasks/${id}/move`, {
      method: "POST",
      body: JSON.stringify(body),
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
  "tag_task",
  "Add and/or remove tags on a task atomically. remove[] is applied first, then add[]. Avoids the get-then-set race when only changing some tags.",
  {
    id: z.string().describe("The task record ID"),
    add: z.array(z.string()).optional().describe("Tags to add (deduped)"),
    remove: z.array(z.string()).optional().describe("Tags to remove"),
  },
  async ({ id, ...body }) => {
    const data = await api(`/tasks/${id}/tags`, {
      method: "POST",
      body: JSON.stringify(body),
    });
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

server.tool(
  "unsnooze_task",
  "Clear a task's snooze (makes it visible again immediately)",
  { id: z.string().describe("The task record ID") },
  async ({ id }) => {
    const data = await api(`/tasks/${id}/unsnooze`, { method: "POST" });
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
    expiresAt: z.string().optional().describe("Optional ISO date for invite expiry"),
  },
  async ({ targetType, targetId, expiresAt }) => {
    const data = await apiRaw("/sharing/invite", {
      method: "POST",
      body: JSON.stringify({ targetType, targetId, expiresAt }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "list_invites",
  "List sharing invites the authenticated user has created (newest first), including redemption status and expiry.",
  {},
  async () => {
    const data = await apiRaw("/sharing/invites");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_invite",
  "Update an existing invite (currently just expires_at)",
  {
    id: z.string().describe("The invite record ID"),
    expiresAt: z.string().optional().describe("ISO date for new expiry (empty string to remove)"),
  },
  async ({ id, expiresAt }) => {
    const data = await apiRaw(`/sharing/invite/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ expiresAt }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "delete_invite",
  "Revoke (delete) a sharing invite",
  { id: z.string().describe("The invite record ID") },
  async ({ id }) => {
    const data = await apiRaw(`/sharing/invite/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Money tools (read-only proxy to ingest) ---

/** GET /money/<path>?<qs> through apiRaw. */
async function money(path: string, params?: Record<string, string | undefined>): Promise<unknown> {
  const qs = params
    ? Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
        .join("&")
    : "";
  return apiRaw(`/money${path}${qs ? `?${qs}` : ""}`);
}

server.tool(
  "list_money_accounts",
  "List all financial accounts (checking, savings, credit cards, investment, etc.) across institutions. Returns id, name, institution, account_type, current balance, and performance data.",
  {},
  async () => {
    const data = await money("/accounts");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "list_money_balances",
  "List balance snapshots, optionally filtered to a single account. Useful for short-window balance history.",
  {
    account_id: z.string().optional().describe("Filter to a specific account id"),
  },
  async ({ account_id }) => {
    const data = await money("/balances", { account_id });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "list_money_transactions",
  "List transactions across all accounts, with optional filters. Categories use a hierarchical path like 'Food/Groceries' or 'Travel/Lodging'. Negative amounts on credit cards = money owed.",
  {
    account_id: z.string().optional().describe("Filter to a specific account id"),
    category: z.string().optional().describe("Filter to a category prefix (e.g. 'Food' matches 'Food/Groceries')"),
    start: z.string().optional().describe("Inclusive start date (YYYY-MM-DD)"),
    end: z.string().optional().describe("Inclusive end date (YYYY-MM-DD)"),
    limit: z.string().optional().describe("Max rows (default ingest-side cap)"),
  },
  async ({ account_id, category, start, end, limit }) => {
    const data = await money("/transactions", { account_id, category, start, end, limit });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_money_net_worth_summary",
  "Current net worth across all accounts, broken down by category (assets/liabilities) and institution.",
  {},
  async () => {
    const data = await money("/net-worth/summary");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_money_net_worth_history",
  "Net worth time series over the requested date range. Returns one point per snapshot date.",
  {
    start: z.string().optional().describe("Inclusive start date (YYYY-MM-DD)"),
    end: z.string().optional().describe("Inclusive end date (YYYY-MM-DD)"),
  },
  async ({ start, end }) => {
    const data = await money("/net-worth/history", { start, end });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_money_performance",
  "Investment performance (invested vs earned, returns) as a time series. Filter by account or institution.",
  {
    account_id: z.string().optional().describe("Filter to a specific account id"),
    institution: z.string().optional().describe("Filter to a specific institution"),
  },
  async ({ account_id, institution }) => {
    const data = await money("/performance", { account_id, institution });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_money_spending_summary",
  "Spending aggregated by category and/or time period. Use for 'how much did I spend on groceries last month'-style questions.",
  {
    range: z.string().optional().describe("Time range hint: e.g. 'month', 'quarter', 'year', or a date range"),
  },
  async ({ range }) => {
    const data = await money("/spending/summary", { range });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "list_money_holdings",
  "Investment holdings (positions) across accounts. Returns symbol, quantity, cost basis, current value per position.",
  {
    account_id: z.string().optional().describe("Filter to a specific account id"),
  },
  async ({ account_id }) => {
    const data = await money("/holdings", { account_id });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_money_allocation",
  "Asset allocation breakdown (e.g. stocks/bonds/cash/etc.) across the investment portfolio.",
  {},
  async () => {
    const data = await money("/allocation");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "list_money_recurring",
  "Detected recurring transactions (subscriptions, recurring transfers, etc.) with cadence and last-seen date.",
  {},
  async () => {
    const data = await money("/recurring");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "list_money_institutions",
  "List financial institutions configured in the money database (lookup table for resolving names referenced by accounts/transactions).",
  {},
  async () => {
    const data = await money("/institutions");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "list_money_people",
  "List people configured in the money database (counterparties in shared expenses, transfers, etc.).",
  {},
  async () => {
    const data = await money("/people");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

  return server;
}

// --- Start (stdio bootstrap, used by `pnpm mcp` and the local .mcp.json) ---

async function main() {
  const apiToken = process.env.HOMELAB_API_TOKEN || "";
  if (!apiToken) {
    console.error("HOMELAB_API_TOKEN env var is required. Generate one in Settings → API Tokens.");
    process.exit(1);
  }
  const server = buildMcpServer(apiToken);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Homelab MCP server running on stdio");
}

// Only run the stdio bootstrap when this file is invoked directly (e.g. `pnpm mcp`).
// When imported by index.ts to mount the HTTP transport, skip main().
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
