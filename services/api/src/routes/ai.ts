import { Hono } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import {
  getAnthropicClient,
  extractText,
  CLAUDE_MODEL,
  parseAIResponse,
  normalizeTags,
  fetchRecipeData,
  buildEnrichmentPrompt,
} from "../lib/ai";

export const aiRoutes = new Hono<AppEnv>();

// Manually trigger AI enrichment for a recipe
aiRoutes.post("/enrich", handler(async (c) => {
  const { recipeId } = await c.req.json<{ boxId: string; recipeId: string }>();
  if (!recipeId) {
    return c.json({ error: "Must provide recipeId" }, 400);
  }

  const pb = c.get("pb");
  const { recipe, ingredients, instructions } = await fetchRecipeData(pb, recipeId);

  const anthropic = getAnthropicClient();
  const enrichmentPrompt = buildEnrichmentPrompt(
    String(recipe.name || "Unknown"),
    ingredients,
    instructions.map((text, idx) => `Step ${idx + 1}: ${text}`),
    recipe.description ? String(recipe.description) : undefined,
  );

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    messages: [{ role: "user", content: enrichmentPrompt }],
  });

  const text = extractText(response);
  const enrichment = parseAIResponse<{
    description?: string;
    suggestedTags?: string[];
    stepIngredients?: string[][];
    reasoning?: string;
  }>(text);

  enrichment.suggestedTags = normalizeTags(enrichment.suggestedTags);

  const stepIngredientsObj: Record<string, string[]> = {};
  if (Array.isArray(enrichment.stepIngredients)) {
    enrichment.stepIngredients.forEach((ings, idx) => {
      stepIngredientsObj[idx.toString()] = Array.isArray(ings) ? ings : [];
    });
  }

  const pendingChanges = {
    data: {
      description: enrichment.description || "",
      recipeCategory: enrichment.suggestedTags || [],
    },
    stepIngredients: stepIngredientsObj,
    source: "enrichment",
    reasoning: enrichment.reasoning || "",
    generatedAt: new Date().toISOString(),
    model: CLAUDE_MODEL,
  };

  await pb.collection("recipes").update(recipeId, {
    pending_changes: pendingChanges,
    enrichment_status: "pending",
  });

  return c.json({ success: true, enrichment: pendingChanges });
}));
