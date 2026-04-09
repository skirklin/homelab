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
  GENERATE_RECIPE_SYSTEM_PROMPT,
  buildEnrichmentPrompt,
  buildModificationPrompt,
} from "../lib/ai";

export const aiRoutes = new Hono<AppEnv>();

// Generate a recipe from a text prompt
aiRoutes.post("/generate", handler(async (c) => {
  const { prompt } = await c.req.json<{ prompt: string }>();
  if (!prompt || typeof prompt !== "string") {
    return c.json({ error: "Must provide a prompt" }, 400);
  }

  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content: `Create a recipe for: ${prompt}` }],
    system: GENERATE_RECIPE_SYSTEM_PROMPT,
  });

  const text = extractText(response);
  const recipe = parseAIResponse(text);

  if (recipe && typeof recipe === "object" && "recipeCategory" in recipe) {
    (recipe as Record<string, unknown>).recipeCategory = normalizeTags(
      (recipe as Record<string, unknown>).recipeCategory as string[]
    );
  }

  return c.json({ recipeJson: JSON.stringify(recipe) });
}));

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

// Modify a recipe based on user feedback
aiRoutes.post("/modify", handler(async (c) => {
  const { recipeId, feedback } = await c.req.json<{
    boxId: string;
    recipeId: string;
    feedback: string;
  }>();
  if (!recipeId || !feedback) {
    return c.json({ error: "Must provide recipeId and feedback" }, 400);
  }

  const pb = c.get("pb");
  const { recipe, ingredients, instructions } = await fetchRecipeData(pb, recipeId);

  const anthropic = getAnthropicClient();
  const modificationPrompt = buildModificationPrompt(
    String(recipe.name || "Unknown"),
    recipe.description ? String(recipe.description) : undefined,
    ingredients,
    instructions,
    feedback,
  );

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content: modificationPrompt }],
  });

  const text = extractText(response);
  const modification = parseAIResponse<{
    modifiedRecipe?: {
      name?: string;
      description?: string;
      recipeIngredient?: string[];
      recipeInstructions?: Array<{ text: string }>;
    };
    reasoning?: string;
  }>(text);

  const now = new Date().toISOString();
  const pendingChanges = {
    data: {
      name: modification.modifiedRecipe?.name,
      description: modification.modifiedRecipe?.description,
      recipeIngredient: modification.modifiedRecipe?.recipeIngredient || ingredients,
      recipeInstructions: modification.modifiedRecipe?.recipeInstructions || instructions.map((text) => ({ text })),
    },
    source: "modification",
    prompt: feedback,
    reasoning: modification.reasoning || "",
    generatedAt: now,
    model: CLAUDE_MODEL,
  };

  await pb.collection("recipes").update(recipeId, { pending_changes: pendingChanges });

  return c.json({
    success: true,
    modificationJson: JSON.stringify({ ...pendingChanges, generatedAt: now }),
  });
}));
