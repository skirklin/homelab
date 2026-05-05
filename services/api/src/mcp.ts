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

// Builds a configured MCP server bound to a specific API token. Inner closures
// capture `apiToken`, so each caller (stdio bootstrap, per-request HTTP handler)
// gets its own server scoped to the right user identity. The body is left at
// module-level indentation to keep this refactor a thin wrapper, not a rewrite.
export function buildMcpServer(apiToken: string): McpServer {

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
  description: z.string().optional().describe("Brief qualifying note. NOT costs/durations/logistics."),
  cost_notes: z.string().optional().describe("Cost notes (e.g. '$25/person')"),
  duration_estimate: z.string().optional().describe("Duration (e.g. '2h', 'half day')"),
  walk_miles: z.number().optional().describe("Distance walked or hiked in miles (e.g. trail length)"),
  elevation_gain_feet: z.number().optional().describe("Elevation gain in feet (Hiking activities)"),
  difficulty: z.enum(["easy", "moderate", "hard", "strenuous", ""]).optional().describe("Hike difficulty rating"),
  setting: z.enum(["outdoor", "indoor", "either"]).optional(),
  trip_id: z.string().optional().describe("Trip this activity belongs to"),
  confirmation_code: z.string().optional().describe("Booking confirmation code"),
  details: z.string().optional().describe("Freeform details text"),
  flight_info: flightInfoSchema.optional(),
  booking_reqs: z.record(z.unknown()).optional().describe("Booking requirements (JSON)"),
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

// --- Upkeep write tools ---

const taskFrequencySchema = z.object({
  value: z.number(),
  unit: z.enum(["days", "weeks", "months"]),
});

server.tool(
  "add_task",
  "Create a task. Supports nesting (parent_id), task types (recurring/one_shot), tags, and notification subscribers.",
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

// --- Trip Proposals ---

const candidateFeedbackSchema = z.object({
  vote: z.enum(["up", "down"]).optional(),
  picked: z.boolean().optional(),
  notes: z.string().optional(),
}).describe("Per-candidate feedback from the user");

server.tool(
  "list_trip_proposals",
  "List planning proposals for a trip. Use unread_only=true at the start of a planning session to find proposals with new user feedback since your last view — this is the primary way to see what needs your attention. Calling this auto-marks returned proposals as seen.",
  {
    trip_id: z.string().describe("The trip record ID"),
    state: z.enum(["open", "resolved"]).optional().describe("Filter by state"),
    unread_only: z.boolean().optional().describe("Only return proposals where the user has responded since you last viewed them"),
  },
  async ({ trip_id, state, unread_only }) => {
    const params = new URLSearchParams({ trip: trip_id });
    if (state) params.set("state", state);
    if (unread_only) params.set("unread_only", "true");
    const data = await api(`/travel/proposals?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_trip_proposal",
  "Get a single proposal including user's picks, per-candidate feedback, and overall comments",
  { id: z.string().describe("The proposal record ID") },
  async ({ id }) => {
    const data = await api(`/travel/proposals/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "create_trip_proposal",
  "Create a new proposal (curated comparison of options) for the user. Candidate IDs must reference existing activities on the trip — create activities first if needed.",
  {
    trip_id: z.string().describe("The trip record ID"),
    question: z.string().describe("The question being asked (e.g. 'Which Edinburgh hotel should we book?')"),
    reasoning: z.string().optional().describe("Your overall reasoning/pitch (markdown allowed — links and lists render)"),
    candidate_ids: z.array(z.string()).describe("Activity IDs being compared (must already exist on the trip)"),
    claude_picks: z.array(z.string()).optional().describe("Activity IDs you recommend (can be multiple, or empty)"),
  },
  async ({ trip_id, question, reasoning, candidate_ids, claude_picks }) => {
    const data = await api("/travel/proposals", {
      method: "POST",
      body: JSON.stringify({ trip: trip_id, question, reasoning, candidate_ids, claude_picks }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_trip_proposal",
  "Revise a proposal (e.g. add candidates, update reasoning, change claude_picks). For recording user feedback, prefer the dedicated fields — the user sets feedback via the UI, but you can also write to them directly.",
  {
    id: z.string().describe("The proposal record ID"),
    question: z.string().optional(),
    reasoning: z.string().optional(),
    candidate_ids: z.array(z.string()).optional(),
    claude_picks: z.array(z.string()).optional(),
    feedback: z.record(candidateFeedbackSchema).optional().describe("Per-candidate feedback keyed by activity ID"),
    overall_feedback: z.string().optional(),
    state: z.enum(["open", "resolved"]).optional(),
  },
  async ({ id, ...fields }) => {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) body[k] = v;
    }
    const data = await api(`/travel/proposals/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "resolve_trip_proposal",
  "Mark a proposal as resolved — done with this comparison. Usually the user does this via the UI after picking or dismissing.",
  { id: z.string().describe("The proposal record ID") },
  async ({ id }) => {
    const data = await api(`/travel/proposals/${id}/resolve`, { method: "POST" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "delete_trip_proposal",
  "Delete a proposal entirely",
  { id: z.string().describe("The proposal record ID") },
  async ({ id }) => {
    const data = await api(`/travel/proposals/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
