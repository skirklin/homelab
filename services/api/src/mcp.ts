/**
 * MCP server exposing homelab recipe, shopping, and upkeep data as tools.
 * Calls the HTTP API internally so it goes through the same auth and business logic.
 *
 * Run with: pnpm mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.API_BASE || "https://api.beta.kirkl.in/fn";
const API_TOKEN = process.env.HOMELAB_API_TOKEN || "";

if (!API_TOKEN) {
  console.error("HOMELAB_API_TOKEN env var is required. Generate one in Settings → API Tokens.");
  process.exit(1);
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${API_BASE}/data${path}`;
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
  "List upkeep tasks in a task list",
  { list: z.string().describe("The task list ID") },
  async ({ list }) => {
    const data = await api(`/tasks?list=${list}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Travel tools ---

server.tool(
  "list_travel_trips",
  "List all travel trips across all travel logs for the authenticated user",
  {},
  async () => {
    const logs = (await api("/travel/logs")) as Array<{ id: string; slug: string; name: string }>;
    const allTrips: unknown[] = [];
    for (const log of logs) {
      const trips = (await api(`/travel/trips?log=${log.id}`)) as Array<Record<string, unknown>>;
      allTrips.push(...trips.map((t) => ({ ...t, logName: log.name, logSlug: log.slug })));
    }
    return { content: [{ type: "text", text: JSON.stringify(allTrips, null, 2) }] };
  },
);

server.tool(
  "get_travel_trip",
  "Get a single travel trip with its activities and itineraries",
  { id: z.string().describe("The travel trip record ID") },
  async ({ id }) => {
    // We need to find the trip's log to fetch activities/itineraries
    const logs = (await api("/travel/logs")) as Array<{ id: string; slug: string; name: string }>;
    let trip: Record<string, unknown> | null = null;
    let logId: string | null = null;
    for (const log of logs) {
      const trips = (await api(`/travel/trips?log=${log.id}`)) as Array<Record<string, unknown>>;
      const found = trips.find((t) => t.id === id);
      if (found) {
        trip = found;
        logId = log.id;
        break;
      }
    }
    if (!trip || !logId) {
      return { content: [{ type: "text", text: `Trip "${id}" not found` }] };
    }
    const [activities, itineraries] = await Promise.all([
      api(`/travel/activities?log=${logId}`) as Promise<Array<Record<string, unknown>>>,
      api(`/travel/itineraries?log=${logId}`) as Promise<Array<Record<string, unknown>>>,
    ]);
    const tripActivities = activities.filter((a) => a.trip_id === id);
    const tripItineraries = itineraries.filter((i) => i.trip_id === id);
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
