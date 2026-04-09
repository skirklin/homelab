import { Hono } from "hono";
import type { AppEnv } from "../index";
import { userClient } from "../lib/pb";
import {
  getAnthropicClient,
  CLAUDE_MODEL,
  parseAIResponse,
  normalizeTags,
  GENERATE_RECIPE_SYSTEM_PROMPT,
  buildEnrichmentPrompt,
  buildModificationPrompt,
} from "../lib/ai";

export const aiRoutes = new Hono<AppEnv>();

// Generate a recipe from a text prompt
aiRoutes.post("/generate", async (c) => {
  const { prompt } = await c.req.json<{ prompt: string }>();
  if (!prompt || typeof prompt !== "string") {
    return c.json({ error: "Must provide a prompt" }, 400);
  }

  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: `Create a recipe for: ${prompt}` }],
      system: GENERATE_RECIPE_SYSTEM_PROMPT,
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const recipe = parseAIResponse(text);

    if (recipe && typeof recipe === "object" && "recipeCategory" in recipe) {
      (recipe as Record<string, unknown>).recipeCategory = normalizeTags(
        (recipe as Record<string, unknown>).recipeCategory as string[]
      );
    }

    return c.json({ recipeJson: JSON.stringify(recipe) });
  } catch (err) {
    console.error("Error generating recipe:", err);
    return c.json({ error: "Failed to generate recipe" }, 500);
  }
});

// Manually trigger AI enrichment for a recipe
aiRoutes.post("/enrich", async (c) => {
  const { recipeId } = await c.req.json<{ boxId: string; recipeId: string }>();
  if (!recipeId) {
    return c.json({ error: "Must provide recipeId" }, 400);
  }

  try {
    const pb = userClient(c.get("userToken"));
    const record = await pb.collection("recipes").getOne(recipeId);
    const recipe = record.data as Record<string, unknown>;
    if (!recipe) {
      return c.json({ error: "Recipe data is missing" }, 404);
    }

    const ingredients = Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : [];
    const instructions = Array.isArray(recipe.recipeInstructions)
      ? (recipe.recipeInstructions as Array<{ text?: string } | string>).map(
          (i, idx) => `Step ${idx + 1}: ${typeof i === "string" ? i : (i as { text?: string }).text || ""}`
        )
      : [];

    const anthropic = getAnthropicClient();
    const enrichmentPrompt = buildEnrichmentPrompt(
      String(recipe.name || "Unknown"),
      ingredients,
      instructions,
      recipe.description ? String(recipe.description) : undefined,
    );

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: enrichmentPrompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
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
  } catch (err) {
    console.error("Error enriching recipe:", err);
    return c.json({ error: "Failed to enrich recipe" }, 500);
  }
});

// Modify a recipe based on user feedback
aiRoutes.post("/modify", async (c) => {
  const { recipeId, feedback } = await c.req.json<{
    boxId: string;
    recipeId: string;
    feedback: string;
  }>();
  if (!recipeId || !feedback) {
    return c.json({ error: "Must provide recipeId and feedback" }, 400);
  }

  try {
    const pb = userClient(c.get("userToken"));
    const record = await pb.collection("recipes").getOne(recipeId);
    const recipe = record.data as Record<string, unknown>;
    if (!recipe) {
      return c.json({ error: "Recipe data is missing" }, 404);
    }

    const ingredients = Array.isArray(recipe.recipeIngredient) ? (recipe.recipeIngredient as string[]) : [];
    const instructions = Array.isArray(recipe.recipeInstructions)
      ? (recipe.recipeInstructions as Array<{ text?: string } | string>).map((i) =>
          typeof i === "string" ? i : (i as { text?: string }).text || ""
        )
      : [];

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

    const text = response.content[0].type === "text" ? response.content[0].text : "";
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
  } catch (err) {
    console.error("Error modifying recipe:", err);
    return c.json({ error: "Failed to modify recipe" }, 500);
  }
});
