import { describe, it, expect } from "vitest";
import {
  formatRecipeForPrompt,
  parseEnrichmentResponse,
  Recipe,
} from "./enrich-recipes.js";

describe("formatRecipeForPrompt", () => {
  it("formats a complete recipe", () => {
    const recipe: Recipe = {
      name: "Test Recipe",
      description: "A test description",
      recipeIngredient: ["1 cup flour", "2 eggs"],
      recipeInstructions: [{ text: "Mix ingredients" }, { text: "Bake" }],
      recipeCategory: ["dessert", "baking"],
    };

    const result = formatRecipeForPrompt(recipe);

    expect(result).toContain("Name: Test Recipe");
    expect(result).toContain("1 cup flour");
    expect(result).toContain("2 eggs");
    expect(result).toContain("1. Mix ingredients");
    expect(result).toContain("2. Bake");
    expect(result).toContain("Current tags: dessert, baking");
  });

  it("handles recipe with no ingredients", () => {
    const recipe: Recipe = {
      name: "Simple Recipe",
      recipeInstructions: [{ text: "Do something" }],
    };

    const result = formatRecipeForPrompt(recipe);

    expect(result).toContain("Name: Simple Recipe");
    expect(result).not.toContain("Ingredients:");
  });

  it("handles string instructions", () => {
    const recipe: Recipe = {
      name: "Recipe",
      recipeInstructions: "Just do it all in one step",
    };

    const result = formatRecipeForPrompt(recipe);

    expect(result).toContain("Just do it all in one step");
  });

  it("handles single category as string", () => {
    const recipe: Recipe = {
      name: "Recipe",
      recipeCategory: "dinner",
    };

    const result = formatRecipeForPrompt(recipe);

    expect(result).toContain("Current tags: dinner");
  });

  it("handles empty recipe", () => {
    const recipe: Recipe = {};

    const result = formatRecipeForPrompt(recipe);

    expect(result).toBe("");
  });
});

describe("parseEnrichmentResponse", () => {
  it("parses plain JSON response", () => {
    const response = `{
      "description": "A delicious recipe",
      "suggestedTags": ["dinner", "quick"],
      "reasoning": "Easy to make"
    }`;

    const result = parseEnrichmentResponse(response);

    expect(result.description).toBe("A delicious recipe");
    expect(result.suggestedTags).toEqual(["dinner", "quick"]);
    expect(result.reasoning).toBe("Easy to make");
  });

  it("parses JSON wrapped in markdown code block", () => {
    const response = `Here's my analysis:

\`\`\`json
{
  "description": "A tasty dish",
  "suggestedTags": ["lunch"],
  "reasoning": "Perfect for midday"
}
\`\`\`

Hope this helps!`;

    const result = parseEnrichmentResponse(response);

    expect(result.description).toBe("A tasty dish");
    expect(result.suggestedTags).toEqual(["lunch"]);
  });

  it("parses JSON in code block without language specifier", () => {
    const response = `\`\`\`
{
  "description": "Test",
  "suggestedTags": [],
  "reasoning": "None"
}
\`\`\``;

    const result = parseEnrichmentResponse(response);

    expect(result.description).toBe("Test");
  });

  it("throws on invalid JSON", () => {
    const response = "This is not JSON at all";

    expect(() => parseEnrichmentResponse(response)).toThrow(
      "Failed to parse response as JSON"
    );
  });

  it("throws on incomplete JSON", () => {
    const response = '{ "description": "incomplete';

    expect(() => parseEnrichmentResponse(response)).toThrow(
      "Failed to parse response as JSON"
    );
  });
});
