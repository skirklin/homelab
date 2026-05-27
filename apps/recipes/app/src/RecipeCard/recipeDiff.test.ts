import { describe, it, expect } from "vitest";
import { diffRecipes, ingredientKey } from "./recipeDiff";

describe("ingredientKey", () => {
  it("strips leading quantity, unit, and trailing prep notes", () => {
    expect(ingredientKey("1 1/2 cups whole milk")).toBe("whole milk");
    expect(ingredientKey("2 tbsp olive oil")).toBe("olive oil");
    expect(ingredientKey("3 cloves garlic, minced")).toBe("garlic");
    expect(ingredientKey("1 lb ground beef, lean")).toBe("ground beef");
  });

  it("strips trailing parenthetical", () => {
    expect(ingredientKey("2 cups flour (all-purpose)")).toBe("flour");
    expect(ingredientKey("olive oil (extra virgin)")).toBe("olive oil");
  });

  it("handles fractions and unicode glyphs", () => {
    expect(ingredientKey("½ cup sugar")).toBe("sugar");
    expect(ingredientKey("¼ tsp salt")).toBe("salt");
  });

  it("handles ranges", () => {
    expect(ingredientKey("1-2 cups water")).toBe("water");
    expect(ingredientKey("1 to 2 tbsp lemon juice")).toBe("lemon juice");
  });

  it("lowercases and trims", () => {
    expect(ingredientKey("  OLIVE OIL  ")).toBe("olive oil");
  });

  it("leaves unrecognised input intact (minus quantity)", () => {
    // No known unit; the whole thing is the name.
    expect(ingredientKey("salt to taste")).toBe("salt to taste");
  });

  it("is empty for whitespace-only", () => {
    expect(ingredientKey("   ")).toBe("");
  });
});

describe("diffRecipes — empty cases", () => {
  it("returns isEmpty true for identical recipes", () => {
    const r = {
      recipeIngredient: ["1 cup milk", "2 eggs"],
      recipeInstructions: [{ text: "Mix" }, { text: "Bake" }],
      name: "Test",
    };
    const d = diffRecipes(r, r);
    expect(d.isEmpty).toBe(true);
    expect(d.ingredients).toEqual([]);
    expect(d.steps).toEqual([]);
    expect(d.fields).toEqual([]);
  });

  it("handles null/undefined inputs without crashing", () => {
    expect(diffRecipes(undefined, undefined).isEmpty).toBe(true);
    expect(diffRecipes(null, null).isEmpty).toBe(true);
    expect(diffRecipes({}, {}).isEmpty).toBe(true);
  });

  it("handles a recipe with no snapshot — every after-only field becomes added", () => {
    const after = {
      recipeIngredient: ["1 cup milk"],
      recipeInstructions: [{ text: "Mix" }],
    };
    const d = diffRecipes(undefined, after);
    expect(d.ingredients).toHaveLength(1);
    expect(d.ingredients[0].kind).toBe("added");
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0].kind).toBe("added");
  });
});

describe("diffRecipes — ingredients", () => {
  it("detects a quantity change on a matched ingredient", () => {
    const before = { recipeIngredient: ["3 cups milk", "2 eggs"] };
    const after = { recipeIngredient: ["4 cups milk", "2 eggs"] };
    const d = diffRecipes(before, after);
    expect(d.ingredients).toEqual([
      { kind: "changed", name: "milk", before: "3 cups milk", after: "4 cups milk" },
    ]);
  });

  it("detects added ingredient", () => {
    const before = { recipeIngredient: ["1 cup flour"] };
    const after = { recipeIngredient: ["1 cup flour", "2 tbsp olive oil"] };
    const d = diffRecipes(before, after);
    expect(d.ingredients).toEqual([
      { kind: "added", name: "olive oil", after: "2 tbsp olive oil" },
    ]);
  });

  it("detects removed ingredient", () => {
    const before = { recipeIngredient: ["1 cup flour", "1 tsp salt"] };
    const after = { recipeIngredient: ["1 cup flour"] };
    const d = diffRecipes(before, after);
    expect(d.ingredients).toEqual([
      { kind: "removed", name: "salt", before: "1 tsp salt" },
    ]);
  });

  it("matches ingredients across preparation note edits", () => {
    const before = { recipeIngredient: ["2 cloves garlic"] };
    const after = { recipeIngredient: ["2 cloves garlic, minced"] };
    const d = diffRecipes(before, after);
    // Same key ("garlic"), different raw strings → "changed"
    expect(d.ingredients).toEqual([
      { kind: "changed", name: "garlic", before: "2 cloves garlic", after: "2 cloves garlic, minced" },
    ]);
  });

  it("handles a recipe with no ingredient list on either side", () => {
    const d = diffRecipes({ name: "x" }, { name: "x" });
    expect(d.ingredients).toEqual([]);
  });

  it("preserves order: added/changed ingredients appear in after-order", () => {
    const before = { recipeIngredient: ["1 cup flour", "1 cup milk"] };
    const after = { recipeIngredient: ["2 cup milk", "1 cup flour", "1 tsp vanilla"] };
    const d = diffRecipes(before, after);
    // Milk first (changed), then vanilla (added). Flour unchanged.
    expect(d.ingredients.map((c) => `${c.kind}:${c.name}`)).toEqual([
      "changed:milk",
      "added:vanilla",
    ]);
  });

  it("handles duplicate ingredient names", () => {
    const before = { recipeIngredient: ["1 tsp salt", "1 tsp salt"] };
    const after = { recipeIngredient: ["1 tsp salt"] };
    const d = diffRecipes(before, after);
    // One salt drops; one stays.
    expect(d.ingredients).toEqual([
      { kind: "removed", name: "salt", before: "1 tsp salt" },
    ]);
  });
});

describe("diffRecipes — steps", () => {
  it("detects an added step at the end", () => {
    const before = { recipeInstructions: [{ text: "Mix" }] };
    const after = { recipeInstructions: [{ text: "Mix" }, { text: "Bake" }] };
    const d = diffRecipes(before, after);
    expect(d.steps).toEqual([
      { kind: "added", index: 2, after: "Bake" },
    ]);
  });

  it("detects a removed step at the end", () => {
    const before = { recipeInstructions: [{ text: "Mix" }, { text: "Bake" }] };
    const after = { recipeInstructions: [{ text: "Mix" }] };
    const d = diffRecipes(before, after);
    expect(d.steps).toEqual([
      { kind: "removed", index: 2, before: "Bake" },
    ]);
  });

  it("detects a changed step by index", () => {
    const before = { recipeInstructions: [{ text: "Mix gently" }] };
    const after = { recipeInstructions: [{ text: "Mix vigorously" }] };
    const d = diffRecipes(before, after);
    expect(d.steps).toEqual([
      { kind: "changed", index: 1, before: "Mix gently", after: "Mix vigorously" },
    ]);
  });

  it("handles string-form instructions (not HowToStep objects)", () => {
    const before = { recipeInstructions: ["Mix"] };
    const after = { recipeInstructions: ["Whisk"] };
    const d = diffRecipes(before, after);
    expect(d.steps).toEqual([
      { kind: "changed", index: 1, before: "Mix", after: "Whisk" },
    ]);
  });

  it("ignores trivial whitespace-only changes", () => {
    const before = { recipeInstructions: [{ text: "Mix" }] };
    const after = { recipeInstructions: [{ text: "  Mix  " }] };
    expect(diffRecipes(before, after).steps).toEqual([]);
  });
});

describe("diffRecipes — scalar fields", () => {
  it("detects yield change", () => {
    const before = { recipeYield: "4 servings" };
    const after = { recipeYield: "6 servings" };
    const d = diffRecipes(before, after);
    expect(d.fields).toEqual([
      { field: "recipeYield", before: "4 servings", after: "6 servings" },
    ]);
  });

  it("detects added/removed scalar fields", () => {
    const before = {};
    const after = { recipeCuisine: "Italian" };
    expect(diffRecipes(before, after).fields).toEqual([
      { field: "recipeCuisine", before: undefined, after: "Italian" },
    ]);
    expect(diffRecipes(after, before).fields).toEqual([
      { field: "recipeCuisine", before: "Italian", after: undefined },
    ]);
  });

  it("ignores non-whitelisted fields like @context and image URLs", () => {
    const before = { "@context": "https://schema.org", image: "before.jpg" };
    const after = { "@context": "https://schema.org", image: "after.jpg" };
    expect(diffRecipes(before, after).fields).toEqual([]);
  });

  it("treats whitespace-only changes as no-op", () => {
    const before = { name: "Pasta" };
    const after = { name: "  Pasta  " };
    expect(diffRecipes(before, after).fields).toEqual([]);
  });
});

describe("diffRecipes — combined", () => {
  it("aggregates ingredients, steps, and fields", () => {
    const before = {
      name: "Carbonara",
      recipeYield: "4 servings",
      recipeIngredient: ["1 lb pasta", "4 eggs", "1 tsp salt"],
      recipeInstructions: [{ text: "Boil water" }, { text: "Cook pasta" }],
    };
    const after = {
      name: "Carbonara",
      recipeYield: "6 servings",
      recipeIngredient: ["1.5 lb pasta", "6 eggs", "1 cup parmesan"],
      recipeInstructions: [{ text: "Boil water" }, { text: "Cook pasta al dente" }, { text: "Toss with sauce" }],
    };
    const d = diffRecipes(before, after);
    expect(d.isEmpty).toBe(false);
    expect(d.ingredients.length).toBeGreaterThan(0);
    expect(d.steps.length).toBeGreaterThan(0);
    expect(d.fields).toEqual([
      { field: "recipeYield", before: "4 servings", after: "6 servings" },
    ]);
  });
});
