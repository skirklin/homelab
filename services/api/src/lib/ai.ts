/**
 * AI/Anthropic utilities — ported from services/functions/src/utils/ai.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import type PocketBase from "pocketbase";

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
    client = new Anthropic({ apiKey });
  }
  return client;
}

/** Extract the text content from an Anthropic message response. */
export function extractText(response: Anthropic.Messages.Message): string {
  const block = response.content.find((b) => b.type === "text");
  return block?.text ?? "";
}

export function parseAIResponse<T>(text: string): T {
  let jsonStr = text.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  try {
    return JSON.parse(jsonStr) as T;
  } catch (err) {
    const preview = jsonStr.slice(0, 200);
    throw new Error(
      `Failed to parse AI response as JSON: ${err instanceof Error ? err.message : err}\nResponse preview: ${preview}`,
    );
  }
}

/** Fetch a recipe record and extract its ingredients and instructions. */
export async function fetchRecipeData(pb: PocketBase, recipeId: string) {
  const record = await pb.collection("recipes").getOne(recipeId);
  const recipe = record.data as Record<string, unknown>;
  if (!recipe) {
    throw Object.assign(new Error("Recipe data is missing"), { statusCode: 404 });
  }

  const ingredients = Array.isArray(recipe.recipeIngredient)
    ? (recipe.recipeIngredient as string[])
    : [];
  const instructions = Array.isArray(recipe.recipeInstructions)
    ? (recipe.recipeInstructions as Array<{ text?: string } | string>).map((i) =>
        typeof i === "string" ? i : (i as { text?: string }).text || "",
      )
    : [];

  return { record, recipe, ingredients, instructions };
}

export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || !Array.isArray(tags)) return [];
  return tags.map((t) => t.toLowerCase());
}

export const GENERATE_RECIPE_SYSTEM_PROMPT = `You are a helpful cooking assistant that generates recipes. When given a description of what the user wants, create a complete recipe.

Return ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "@type": "Recipe",
  "name": "Recipe Name",
  "description": "A brief, appetizing description of the dish",
  "recipeIngredient": ["ingredient 1", "ingredient 2", ...],
  "recipeInstructions": [
    {"@type": "HowToStep", "text": "Step 1 instructions", "ingredients": ["ingredient with amount used in this step"]},
    {"@type": "HowToStep", "text": "Step 2 instructions", "ingredients": ["ingredient 1", "ingredient 2"]},
    ...
  ],
  "recipeCategory": ["category1", "category2"],
  "recipeYield": "4 servings",
  "prepTime": "PT15M",
  "cookTime": "PT30M",
  "notes": "Tips, variations, storage info, and serving suggestions"
}

Guidelines:
- Use clear, concise ingredient measurements
- Write instructions as complete sentences
- Include relevant categories (cuisine type, meal type, dietary info)
- Be creative but practical
- Notes should include: tips/variations, make-ahead/storage instructions, and serving suggestions
- Each step's ingredients array should list the specific ingredients (with amounts) used in that step
- If an ingredient is divided across steps, show the portion used in each step`;

export function buildEnrichmentPrompt(
  recipeName: string,
  ingredients: unknown[],
  instructions: string[],
  existingDescription?: string,
): string {
  return `Analyze this recipe and provide enrichment data.

Recipe Name: ${recipeName}
Ingredients: ${JSON.stringify(ingredients)}
Instructions:
${instructions.join("\n")}
${existingDescription ? `Existing Description: ${existingDescription}` : ""}

Return ONLY valid JSON (no markdown) with:
{
  "description": "A brief, appetizing 1-2 sentence description of the dish",
  "suggestedTags": ["tag1", "tag2", "tag3"],
  "stepIngredients": [
    ["ingredient with amount for step 1", "another ingredient"],
    ["ingredients for step 2"],
    ...
  ],
  "reasoning": "Brief explanation of your analysis"
}

Guidelines:
- Tags should be lowercase: cuisine type, meal type, main protein/ingredient, cooking method, dietary info. Aim for 3-6 tags.
- stepIngredients must have exactly ${instructions.length} arrays (one per step)
- Each step's array lists the specific ingredients (with amounts) used in that step
- If an ingredient is divided across steps, show the portion in each step
- Steps with no ingredients (e.g., "let rest") should have an empty array []`;
}

export function buildModificationPrompt(
  recipeName: string,
  description: string | undefined,
  ingredients: string[],
  instructions: string[],
  feedback: string,
): string {
  return `You are a helpful cooking assistant that modifies recipes based on user feedback.

Current Recipe:
Name: ${recipeName}
Description: ${description || "None"}

Ingredients:
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join("\n")}

Instructions:
${instructions.map((inst, i) => `${i + 1}. ${inst}`).join("\n")}

User Feedback: "${feedback}"

Please modify this recipe based on the feedback. Return ONLY valid JSON (no markdown) in this format:
{
  "modifiedRecipe": {
    "name": "Recipe name (include even if unchanged)",
    "description": "Description (include even if unchanged)",
    "recipeIngredient": ["full list of ingredients after modification"],
    "recipeInstructions": [
      {"@type": "HowToStep", "text": "Step 1 text"},
      {"@type": "HowToStep", "text": "Step 2 text"}
    ]
  },
  "reasoning": "Brief explanation of changes made and why"
}

Guidelines:
- Preserve the recipe's essential character while addressing the feedback
- For dietary changes, substitute ingredients thoughtfully
- For taste adjustments, adjust quantities or suggest alternatives
- Keep the same general structure unless the feedback requires structural changes
- Be specific about quantities in ingredients
- Explain your changes clearly in the reasoning field`;
}
