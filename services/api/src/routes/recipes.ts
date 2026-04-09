import { Hono } from "hono";
import { scrapeRecipesFromUrl } from "../lib/scraper";

export const recipesRoutes = new Hono();

recipesRoutes.post("/scrape", async (c) => {
  const { url } = await c.req.json<{ url: string }>();

  if (!url || typeof url !== "string" || !url.trim()) {
    return c.json({ error: "Must specify a valid URL" }, 400);
  }

  try {
    const recipes = await scrapeRecipesFromUrl(url.trim());
    return c.json({ recipes: JSON.stringify(recipes) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch URL";
    return c.json({ error: message }, 500);
  }
});
