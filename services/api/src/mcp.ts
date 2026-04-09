/**
 * MCP server exposing homelab recipe, shopping, and upkeep data as tools.
 * Calls the HTTP API internally so it goes through the same auth and business logic.
 *
 * Run with: pnpm mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.API_BASE || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "";

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${API_BASE}/data${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "X-API-Key": API_KEY,
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
