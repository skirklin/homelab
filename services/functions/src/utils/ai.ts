/**
 * AI/Anthropic utilities for cloud functions.
 */

import Anthropic from "@anthropic-ai/sdk";
import { defineSecret } from "firebase-functions/params";

// Polyfill fetch globals for Anthropic SDK
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const nodeFetch = require("node-fetch");
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const FormData = require("form-data");

if (!globalThis.fetch) {
  globalThis.fetch = nodeFetch;
  globalThis.Headers = nodeFetch.Headers;
  globalThis.Request = nodeFetch.Request;
  globalThis.Response = nodeFetch.Response;
}
if (!globalThis.FormData) {
  globalThis.FormData = FormData;
}

// Define secrets
export const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

// Model configuration
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-5-20251101";

/**
 * Create an Anthropic client with the provided API key.
 */
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

/**
 * Parse AI response text, handling potential markdown code blocks.
 *
 * @param text - Raw text response from AI
 * @returns Parsed JSON object
 * @throws Error if parsing fails
 */
export function parseAIResponse<T>(text: string): T {
  let jsonStr = text.trim();

  // Handle markdown code blocks
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  return JSON.parse(jsonStr) as T;
}

/**
 * Ensure tags are lowercase.
 */
export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || !Array.isArray(tags)) return [];
  return tags.map((t) => t.toLowerCase());
}

// ===== Prompts =====

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
- If an ingredient is divided across steps, show the portion used in each step (e.g., "1 tbsp butter" in step 1, "2 tbsp butter" in step 3)`;

/**
 * Build enrichment prompt for a recipe.
 */
export function buildEnrichmentPrompt(
  recipeName: string,
  ingredients: unknown[],
  instructions: string[],
  existingDescription?: string
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

/**
 * Build modification prompt for a recipe.
 */
export function buildModificationPrompt(
  recipeName: string,
  description: string | undefined,
  ingredients: string[],
  instructions: string[],
  feedback: string
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
- For dietary changes (vegetarian, vegan, gluten-free), substitute ingredients thoughtfully
- For taste adjustments (too salty, too sweet, too bland), adjust quantities or suggest alternatives
- Keep the same general structure unless the feedback requires structural changes
- Be specific about quantities in ingredients
- Explain your changes clearly in the reasoning field`;
}
